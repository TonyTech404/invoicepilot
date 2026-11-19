// Azure AI Document Intelligence — prebuilt invoice model, called over REST.
// https://learn.microsoft.com/azure/ai-services/document-intelligence/prebuilt/invoice
import { env } from './env.js';
import { normaliseAbn } from './lib/abn.js';
import { cents } from './lib/money.js';
import type { Box, HeaderField, PageSize } from '../../shared/types.js';

const API_VERSION = '2024-11-30';

// ── The parts of the response we use ────────────────────────────────────────
interface DiField {
  type: string;
  content?: string;
  confidence?: number;
  valueString?: string;
  valueDate?: string;
  valueNumber?: number;
  valueCurrency?: { amount: number; currencyCode?: string };
  valueArray?: DiField[];
  valueObject?: Record<string, DiField>;
  boundingRegions?: Array<{ pageNumber: number; polygon: number[] }>;
}

/** The trimmed result we cache: the invoice document and the page sizes. */
export interface DiResult {
  fields: Record<string, DiField>;
  pages: PageSize[];
}

export interface ExtractedLine {
  description: string;
  quantity: number | null;
  unit_price: number | null;
  amount: number;
  /** What the document says about tax on this line ("Free", "10%", "GST"), if anything. */
  tax_hint: string | null;
  read_confidence: number;
  box: Box | null;
}

export interface ExtractedInvoice {
  values: Record<HeaderField, string | number | null> & { currency: string };
  raw_vendor: string | null;
  confidence: Partial<Record<HeaderField, number>>;
  boxes: Partial<Record<HeaderField, Box>>;
  pages: PageSize[];
  lines: ExtractedLine[];
}

export class ExtractionError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sends the document to Azure and waits for the analysis to finish. */
export async function analyzeInvoice(bytes: Uint8Array, signal?: AbortSignal): Promise<DiResult> {
  const url = `${env.docIntelEndpoint}/documentintelligence/documentModels/prebuilt-invoice:analyze?api-version=${API_VERSION}&locale=en-AU`;
  const headers = { 'Ocp-Apim-Subscription-Key': env.docIntelKey };

  const start = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ base64Source: Buffer.from(bytes).toString('base64') }),
    signal,
  });
  if (start.status === 429) throw new ExtractionError('Azure is rate limiting the free tier. Try again in a minute.', true);
  if (start.status !== 202) {
    const body = await start.text();
    throw new ExtractionError(`Document Intelligence rejected the file (${start.status}): ${messageFrom(body)}`);
  }

  const operation = start.headers.get('operation-location');
  if (!operation) throw new ExtractionError('Document Intelligence did not return an operation to poll.');

  const deadline = Date.now() + 40_000;
  let wait = 800;
  while (Date.now() < deadline) {
    await sleep(wait);
    const res = await fetch(operation, { headers, signal });
    if (res.status === 429) {
      wait = Number(res.headers.get('retry-after') ?? 2) * 1000;
      continue;
    }
    const body = (await res.json()) as {
      status: string;
      error?: { message: string };
      analyzeResult?: { documents?: Array<{ fields: Record<string, DiField> }>; pages: PageSize[] };
    };
    if (body.status === 'succeeded') {
      const doc = body.analyzeResult?.documents?.[0];
      if (!doc) throw new ExtractionError('No invoice found in this document.');
      return {
        fields: doc.fields,
        pages: (body.analyzeResult?.pages ?? []).map(({ width, height, unit }) => ({ width, height, unit })),
      };
    }
    if (body.status === 'failed') throw new ExtractionError(body.error?.message ?? 'Analysis failed.');
    wait = 1000;
  }
  throw new ExtractionError('Document Intelligence took longer than 40 seconds.', true);
}

function messageFrom(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; innererror?: { message?: string } } };
    return parsed.error?.innererror?.message ?? parsed.error?.message ?? body.slice(0, 200);
  } catch {
    return body.slice(0, 200);
  }
}

// ── Mapping ─────────────────────────────────────────────────────────────────

const LEGAL_NAME = /\b(pty|ltd|limited|co-?op(erative)?|incorporated|inc|group|trust)\b/i;

/**
 * Vendor names often come back with the logo text glued on
 * ("Highland Green\nCOFFEE TRADERS\nHighland Green Coffee Traders Pty Ltd").
 * Prefer the line that looks like a legal name; otherwise join the lines.
 */
export function cleanVendorName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const lines = raw
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const legal = lines.find((l) => LEGAL_NAME.test(l));
  const name = legal ?? lines.join(' ');
  return name === name.toUpperCase() ? titleCase(name) : name;
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\bPty\b/g, 'Pty').replace(/\bLtd\b/g, 'Ltd');
}

const money = (f?: DiField) => (f?.valueCurrency ? cents(f.valueCurrency.amount) : (f?.valueNumber ?? null));
const text = (f?: DiField) => f?.valueString?.trim() ?? f?.content?.trim() ?? null;
const boxOf = (f?: DiField): Box | null =>
  f?.boundingRegions?.[0] ? { page: f.boundingRegions[0].pageNumber, polygon: f.boundingRegions[0].polygon } : null;

/** Turns Document Intelligence fields into the invoice shape the app uses. */
export function mapInvoice(result: DiResult): ExtractedInvoice {
  const f = result.fields;
  const vendor = f.VendorName ?? f.VendorAddressRecipient;

  const source: Record<HeaderField, DiField | undefined> = {
    supplier_name: vendor,
    supplier_abn: f.VendorTaxId,
    invoice_number: f.InvoiceId,
    invoice_date: f.InvoiceDate,
    due_date: f.DueDate,
    po_number: f.PurchaseOrder,
    subtotal: f.SubTotal,
    tax: f.TotalTax,
    total: f.InvoiceTotal ?? f.AmountDue,
  };

  const lines: ExtractedLine[] = (f.Items?.valueArray ?? []).map((item) => {
    const o = item.valueObject ?? {};
    const quantity = o.Quantity?.valueNumber ?? null;
    const unit_price = money(o.UnitPrice);
    const amount = money(o.Amount) ?? (quantity != null && unit_price != null ? cents(quantity * unit_price) : 0);
    const confidences = [o.Description?.confidence, o.Amount?.confidence].filter((c): c is number => c != null);
    return {
      description: (text(o.Description) ?? '').replace(/\s*\n\s*/g, ' '),
      quantity,
      unit_price,
      amount,
      tax_hint: text(o.TaxRate) ?? text(o.Tax) ?? null,
      read_confidence: confidences.length ? Math.min(...confidences) : (item.confidence ?? 0.5),
      box: boxOf(item),
    };
  });

  const values = {
    supplier_name: cleanVendorName(text(vendor)),
    supplier_abn: normaliseAbn(text(f.VendorTaxId)),
    invoice_number: text(f.InvoiceId),
    invoice_date: f.InvoiceDate?.valueDate ?? null,
    due_date: f.DueDate?.valueDate ?? null,
    po_number: text(f.PurchaseOrder),
    subtotal: money(f.SubTotal),
    tax: money(f.TotalTax),
    total: money(f.InvoiceTotal) ?? money(f.AmountDue),
    currency: f.InvoiceTotal?.valueCurrency?.currencyCode ?? f.SubTotal?.valueCurrency?.currencyCode ?? 'AUD',
  };

  const confidence: Partial<Record<HeaderField, number>> = {};
  const boxes: Partial<Record<HeaderField, Box>> = {};
  for (const [key, field] of Object.entries(source) as Array<[HeaderField, DiField | undefined]>) {
    if (field?.confidence != null) confidence[key] = field.confidence;
    const box = boxOf(field);
    if (box) boxes[key] = box;
  }

  // Fill gaps the document implies, and mark them as low confidence so a person checks them.
  if (values.subtotal == null && lines.length) {
    values.subtotal = cents(lines.reduce((s, l) => s + l.amount, 0));
    confidence.subtotal = 0.5;
  }
  if (values.tax == null && values.total != null && values.subtotal != null) {
    values.tax = cents(values.total - values.subtotal);
    confidence.tax = 0.5;
  }
  if (values.total == null && values.subtotal != null) {
    values.total = cents(values.subtotal + (values.tax ?? 0));
    confidence.total = 0.5;
  }

  return { values, raw_vendor: text(vendor), confidence, boxes, pages: result.pages, lines };
}
