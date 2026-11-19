// Deterministic checks a reviewer sees next to the extracted invoice.
// Errors block approval; warnings and info do not.
import { isValidAbn } from './lib/abn.js';
import { differs, sum, cents } from './lib/money.js';
import type { Account, Check, HeaderField, TaxCode } from '../../shared/types.js';

export interface CheckInput {
  supplier_name: string | null;
  supplier_abn: string | null;
  supplier_known: boolean;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  confidence: Partial<Record<HeaderField, number>>;
  lines: Array<{
    position: number;
    amount: number;
    tax_code: TaxCode | null;
    account_code: string | null;
    ai_account_code: string | null;
    ai_confidence: number | null;
    read_confidence: number | null;
  }>;
  accounts: Pick<Account, 'code' | 'name' | 'active'>[];
  duplicateOf: { invoice_number: string; status: string; created_at: string } | null;
  today: string; // YYYY-MM-DD
}

const LABELS: Record<HeaderField, string> = {
  supplier_name: 'supplier',
  supplier_abn: 'ABN',
  invoice_number: 'invoice number',
  invoice_date: 'invoice date',
  due_date: 'due date',
  po_number: 'PO number',
  subtotal: 'subtotal',
  tax: 'GST',
  total: 'total',
};

const money = (n: number) => `$${n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function runChecks(i: CheckInput): Check[] {
  const out: Check[] = [];

  // Required fields
  for (const field of ['supplier_name', 'invoice_number', 'invoice_date', 'total'] as const) {
    if (i[field] == null || i[field] === '') {
      out.push({ id: `missing_${field}`, level: 'error', field, message: `The ${LABELS[field]} is missing.` });
    }
  }

  // ABN
  if (!i.supplier_abn) {
    out.push({ id: 'abn_missing', level: 'warning', field: 'supplier_abn', message: 'No ABN on this invoice. Without one you may need to withhold tax from the payment.' });
  } else if (!isValidAbn(i.supplier_abn)) {
    out.push({ id: 'abn_invalid', level: 'warning', field: 'supplier_abn', message: 'This ABN fails the checksum, so a digit is probably wrong. Check it on ABN Lookup before paying.' });
  }

  // Arithmetic
  if (i.lines.length && i.subtotal != null) {
    const lines = sum(i.lines.map((l) => l.amount));
    if (differs(lines, i.subtotal, 0.05)) {
      out.push({ id: 'lines_vs_subtotal', level: 'error', field: 'subtotal', message: `Lines add up to ${money(lines)} but the subtotal says ${money(i.subtotal)}.` });
    }
  }
  if (i.subtotal != null && i.tax != null && i.total != null && differs(i.subtotal + i.tax, i.total)) {
    out.push({ id: 'subtotal_plus_tax', level: 'error', field: 'total', message: `Subtotal plus GST is ${money(cents(i.subtotal + i.tax))}, not the total of ${money(i.total)}.` });
  }

  // GST against tax codes
  if (i.tax != null && i.lines.length && i.lines.every((l) => l.tax_code)) {
    const expected = cents(i.lines.filter((l) => l.tax_code === 'GST').reduce((s, l) => s + l.amount * 0.1, 0));
    if (differs(expected, i.tax, 0.05)) {
      out.push({
        id: 'gst_vs_codes',
        level: 'warning',
        field: 'tax',
        message: `GST on the invoice is ${money(i.tax)}, but 10% of the GST-coded lines is ${money(expected)}. A tax code may be wrong.`,
      });
    }
  }

  // Dates
  if (i.invoice_date && i.due_date && i.due_date < i.invoice_date) {
    out.push({ id: 'due_before_issue', level: 'warning', field: 'due_date', message: 'The due date is before the invoice date.' });
  }
  if (i.invoice_date && i.invoice_date > i.today) {
    out.push({ id: 'future_date', level: 'warning', field: 'invoice_date', message: 'The invoice date is in the future.' });
  }

  // Duplicates
  if (i.duplicateOf) {
    out.push({
      id: 'duplicate',
      level: 'error',
      field: 'invoice_number',
      message: `Invoice ${i.duplicateOf.invoice_number} from this supplier is already in the system (${i.duplicateOf.status}). Paying it twice is the most common AP mistake.`,
    });
  }

  // Low read confidence on header fields
  const shaky = (Object.entries(i.confidence) as Array<[HeaderField, number]>)
    // A supplier matched by ABN is known, so how well its name was read no longer matters.
    .filter(([f, c]) => c < 0.8 && !(f === 'supplier_name' && i.supplier_known))
    .map(([f]) => LABELS[f]);
  if (shaky.length) {
    out.push({ id: 'low_read_confidence', level: 'info', message: `Double-check the ${shaky.join(', ')}: the scan was hard to read there.` });
  }

  // Lines
  const accounts = new Map(i.accounts.map((a) => [a.code, a]));
  for (const l of i.lines) {
    const n = l.position;
    if (!l.account_code) {
      out.push({ id: `line_${n}_no_account`, level: 'error', line: n, message: `Line ${n} has no account.` });
    } else if (accounts.get(l.account_code)?.active === false) {
      out.push({ id: `line_${n}_inactive`, level: 'error', line: n, message: `Line ${n} uses ${l.account_code} ${accounts.get(l.account_code)!.name}, which is closed in MYOB.` });
    }
    if (!l.tax_code) out.push({ id: `line_${n}_no_tax`, level: 'error', line: n, message: `Line ${n} has no tax code.` });
    if (l.ai_confidence != null && l.ai_confidence < 0.75 && l.account_code === l.ai_account_code) {
      out.push({ id: `line_${n}_unsure`, level: 'warning', line: n, message: `Line ${n}: the AI was not sure about this account. Please confirm it.` });
    }
    if (l.read_confidence != null && l.read_confidence < 0.7) {
      out.push({ id: `line_${n}_hard_to_read`, level: 'info', line: n, message: `Line ${n} was hard to read. Compare it with the document.` });
    }
  }

  if (!i.supplier_known && i.supplier_name) {
    out.push({ id: 'new_supplier', level: 'info', field: 'supplier_name', message: `${i.supplier_name} is a new supplier. It will be created in MYOB when this bill is posted.` });
  }

  return out;
}

export const hasErrors = (checks: Check[]) => checks.some((c) => c.level === 'error');
