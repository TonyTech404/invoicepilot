// Codes invoice lines to the chart of accounts with Azure OpenAI.
// The model gets the chart, the rules a bookkeeper would apply, and how this supplier's
// lines were coded before (including reviewer corrections), and must answer in a strict schema.
import { env } from './env.js';
import type { Account, TaxCode } from '../../shared/types.js';

export interface LineToCode {
  position: number;
  description: string;
  quantity: number | null;
  unit_price: number | null;
  amount: number;
  tax_hint: string | null;
}

export interface PastCoding {
  description: string;
  account_code: string;
  tax_code: string;
  corrected: boolean; // a reviewer changed the AI's suggestion
}

export interface CodingInput {
  supplier_name: string | null;
  raw_vendor: string | null;
  invoice_total: number | null;
  invoice_tax: number | null;
  lines: LineToCode[];
  accounts: Account[];
  history: PastCoding[];
}

export interface CodedLine {
  position: number;
  account_code: string;
  tax_code: TaxCode;
  confidence: number;
  reason: string;
}

export interface CodingResult {
  supplier_name: string | null;
  notes: string;
  lines: CodedLine[];
  tokens: number;
  ms: number;
}

const TAX_CODES: TaxCode[] = ['GST', 'FRE', 'N-T'];
const FALLBACK = '6-9999';

const RULES = `You code supplier invoice lines for Northbank Coffee Roasters, an Australian specialty coffee roaster with cafes.
For each line pick one account from the chart and one GST tax code.

Rules:
- GST: taxable supply, 10%. FRE: GST-free (basic food: green coffee, milk, cream, unprocessed food). N-T: not reportable (government fees, bank fees).
- If the document marks a line's tax ("Free", "0%", "10%", "GST"), follow it unless it is clearly wrong.
- Equipment bought outright that costs $1,000 or more and lasts over a year is capitalised to 1-2510, not expensed. Under $1,000 goes to 6-1800.
- Labour, call-outs and parts to repair existing equipment go to 6-1100.
- Freight, delivery and port or warehouse charges for stock coming in go to 5-1400, even when they sit on a supplier's goods invoice.
- Only use 6-9999 when nothing else fits.
- Past codings for this supplier are the strongest signal. A past coding marked "corrected" is a human decision: follow it for similar lines.

Confidence: 0.9 or more when the line clearly matches an account or a past coding; 0.6 to 0.85 when it is plausible but another account could fit; under 0.6 when you are guessing or the description looks cut off.
Reason: under 15 words, plain English, for a bookkeeper.
Also return the supplier's name cleaned up (legal or trading name, normal capitalisation, no logo text), and notes: one sentence about anything a reviewer should look at, or an empty string.`;

function schema(codes: string[]) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['supplier_name', 'lines', 'notes'],
    properties: {
      supplier_name: { type: 'string' },
      notes: { type: 'string' },
      lines: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['index', 'account_code', 'tax_code', 'confidence', 'reason'],
          properties: {
            index: { type: 'integer' },
            account_code: { type: 'string', enum: codes },
            tax_code: { type: 'string', enum: TAX_CODES },
            confidence: { type: 'number' },
            reason: { type: 'string' },
          },
        },
      },
    },
  };
}

export function buildPrompt(input: CodingInput): string {
  const chart = input.accounts
    .filter((a) => a.active)
    .map((a) => `${a.code} ${a.name} [default ${a.default_tax_code}]: ${a.description}`)
    .join('\n');

  const history = input.history.length
    ? input.history
        .map((h) => `- "${h.description}" -> ${h.account_code} ${h.tax_code}${h.corrected ? ' (corrected by reviewer)' : ''}`)
        .join('\n')
    : 'None. This is a new supplier.';

  const lines = input.lines
    .map(
      (l) =>
        `${l.position}. "${l.description}" qty ${l.quantity ?? '?'} x ${l.unit_price ?? '?'} = ${l.amount.toFixed(2)}` +
        (l.tax_hint ? ` (document says tax: ${l.tax_hint})` : ''),
    )
    .join('\n');

  return [
    `Chart of accounts:\n${chart}`,
    `Past codings for this supplier:\n${history}`,
    `Invoice from: ${input.supplier_name ?? 'unknown'} (as read from the document: ${JSON.stringify(input.raw_vendor ?? '')})`,
    `Invoice total ${input.invoice_total ?? '?'}, of which GST ${input.invoice_tax ?? '?'}.`,
    `Lines (use the number before the dot as index):\n${lines}`,
  ].join('\n\n');
}

export async function codeLines(input: CodingInput, signal?: AbortSignal): Promise<CodingResult> {
  const codes = input.accounts.filter((a) => a.active).map((a) => a.code);
  const started = Date.now();

  const body = {
    model: env.openAiDeployment,
    reasoning_effort: 'low',
    max_completion_tokens: 4000,
    messages: [
      { role: 'developer', content: RULES },
      { role: 'user', content: buildPrompt(input) },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'invoice_coding', strict: true, schema: schema(codes) },
    },
  };

  let res: Response | undefined;
  for (let attempt = 1; attempt <= 3; attempt++) {
    res = await fetch(`${env.openAiEndpoint}/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { 'api-key': env.openAiKey, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (res.status !== 429 && res.status < 500) break;
    await new Promise((r) => setTimeout(r, Number(res!.headers.get('retry-after') ?? attempt) * 1000));
  }
  if (!res!.ok) throw new Error(`Azure OpenAI returned ${res!.status}: ${(await res!.text()).slice(0, 200)}`);

  const json = (await res!.json()) as {
    choices: Array<{ message: { content: string | null; refusal?: string | null } }>;
    usage?: { total_tokens: number };
  };
  const content = json.choices[0]?.message.content;
  if (!content) throw new Error(json.choices[0]?.message.refusal ?? 'The model returned no content.');

  const parsed = JSON.parse(content) as {
    supplier_name: string;
    notes: string;
    lines: Array<{ index: number; account_code: string; tax_code: TaxCode; confidence: number; reason: string }>;
  };

  // Every line gets an answer, even if the model skipped one.
  const byIndex = new Map(parsed.lines.map((l) => [l.index, l]));
  const lines = input.lines.map((l): CodedLine => {
    const got = byIndex.get(l.position);
    if (!got || !codes.includes(got.account_code)) {
      return { position: l.position, account_code: FALLBACK, tax_code: 'GST', confidence: 0, reason: 'No suggestion for this line.' };
    }
    return {
      position: l.position,
      account_code: got.account_code,
      tax_code: got.tax_code,
      confidence: Math.min(1, Math.max(0, got.confidence)),
      reason: got.reason.trim(),
    };
  });

  return {
    supplier_name: parsed.supplier_name.trim() || null,
    notes: parsed.notes.trim(),
    lines,
    tokens: json.usage?.total_tokens ?? 0,
    ms: Date.now() - started,
  };
}
