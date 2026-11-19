// Types shared by the API and the web app.

export type InvoiceStatus =
  | 'uploaded'
  | 'extracted'
  | 'needs_review'
  | 'approved'
  | 'posting'
  | 'posted'
  | 'failed'
  | 'rejected';

export type TaxCode = 'GST' | 'FRE' | 'N-T';
export type MyobMode = 'healthy' | 'flaky' | 'lost_responses';

/** A region on a page, in the page's own units (inches for PDFs, pixels for images). */
export interface Box {
  page: number;
  polygon: number[];
}

export interface PageSize {
  width: number;
  height: number;
  unit: 'inch' | 'pixel';
}

export const HEADER_FIELDS = [
  'supplier_name',
  'supplier_abn',
  'invoice_number',
  'invoice_date',
  'due_date',
  'po_number',
  'subtotal',
  'tax',
  'total',
] as const;
export type HeaderField = (typeof HEADER_FIELDS)[number];

export interface InvoiceLine {
  id: string;
  position: number;
  description: string;
  quantity: number | null;
  unit_price: number | null;
  amount: number;
  tax_code: TaxCode | null;
  account_code: string | null;
  ai_account_code: string | null;
  ai_tax_code: TaxCode | null;
  ai_confidence: number | null;
  ai_reason: string | null;
  read_confidence: number | null;
  box: Box | null;
}

export interface Check {
  id: string;
  level: 'error' | 'warning' | 'info';
  message: string;
  field?: HeaderField;
  line?: number;
}

export interface InvoiceEvent {
  at: string;
  kind: string;
  message: string;
}

export interface SyncAttempt {
  at: string;
  attempt: number;
  step: 'lookup' | 'supplier' | 'post';
  request: string;
  status: number | null;
  outcome: 'ok' | 'retry' | 'uncertain' | 'fatal' | 'found';
  detail: string | null;
  duration_ms: number;
}

export interface SyncJob {
  state: 'pending' | 'retrying' | 'succeeded' | 'failed';
  attempts: number;
  uncertain: boolean;
  next_attempt_at: string;
  last_error: string | null;
  log: SyncAttempt[];
}

export interface InvoiceSummary {
  id: string;
  status: InvoiceStatus;
  file_name: string;
  supplier_name: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  total: number | null;
  currency: string;
  errors: number;
  warnings: number;
  created_at: string;
  updated_at: string;
}

export interface Invoice extends InvoiceSummary {
  file_mime: string;
  file_url: string;
  supplier_id: string | null;
  supplier_abn: string | null;
  supplier_known: boolean;
  po_number: string | null;
  subtotal: number | null;
  tax: number | null;
  confidence: Partial<Record<HeaderField, number>>;
  boxes: Partial<Record<HeaderField, Box>>;
  pages: PageSize[];
  raw_vendor: string | null;
  extract_ms: number | null;
  code_ms: number | null;
  ai_tokens: number | null;
  ai_notes: string | null;
  myob_bill_uid: string | null;
  posted_at: string | null;
  last_error: string | null;
  lines: InvoiceLine[];
  checks: Check[];
  events: InvoiceEvent[];
  sync: SyncJob | null;
}

export interface Account {
  code: string;
  name: string;
  kind: 'asset' | 'cost_of_sales' | 'expense';
  default_tax_code: TaxCode;
  description: string;
  active: boolean;
}

export interface Session {
  workspace_id: string;
  company_file_id: string;
  myob_mode: MyobMode;
  idempotency_guard: boolean;
}

export interface Stats {
  counts: Record<InvoiceStatus, number>;
  approved_value: number;
  posted_value: number;
  ai_accept_rate: number | null; // share of AI account suggestions kept by reviewers
  avg_extract_ms: number | null;
}

export type ReconcileKind = 'matched' | 'amount_mismatch' | 'missing_in_myob' | 'duplicate_in_myob' | 'myob_only';

export interface ReconcileRow {
  kind: ReconcileKind;
  supplier: string;
  supplier_invoice_number: string | null;
  invoice_id: string | null;
  app_total: number | null;
  myob_total: number | null;
  myob_bill_uids: string[];
  myob_bill_numbers: string[];
  note: string;
}

export interface ReconcileReport {
  ran_at: string;
  rows: ReconcileRow[];
  totals: Record<ReconcileKind, number>;
}

export interface InvoicePatch {
  supplier_name?: string | null;
  supplier_abn?: string | null;
  invoice_number?: string | null;
  invoice_date?: string | null;
  due_date?: string | null;
  po_number?: string | null;
  subtotal?: number | null;
  tax?: number | null;
  total?: number | null;
  lines?: Array<{
    id: string;
    description?: string;
    amount?: number;
    tax_code?: TaxCode | null;
    account_code?: string | null;
  }>;
}
