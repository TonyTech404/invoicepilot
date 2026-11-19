// Gives each new workspace a month of history so every screen has something to show:
// posted bills, one failed post, one invoice waiting for review, and a MYOB company file
// with the kinds of drift reconciliation is for (a duplicate, an edited bill, a manual entry).
//
// Extraction and AI coding values come from history.json, produced by running the real
// pipeline over the PDFs in web/public/samples/history (see scripts/build-seed.ts).
import { randomUUID } from 'node:crypto';
import type { Sql } from '../db.js';
import { cents } from '../lib/money.js';
import history from './history.json' with { type: 'json' };
import type { InvoiceStatus } from '../../../shared/types.js';

interface Fixture {
  file: string;
  size: number;
  extract_ms: number;
  extracted: {
    values: Record<string, string | number | null>;
    raw_vendor: string | null;
    confidence: Record<string, number>;
    boxes: Record<string, unknown>;
    pages: unknown[];
    lines: Array<{ description: string; quantity: number | null; unit_price: number | null; amount: number; tax_hint: string | null; read_confidence: number; box: unknown }>;
  };
  coded: { supplier_name: string | null; notes: string; tokens: number; ms: number; lines: Array<{ position: number; account_code: string; tax_code: string; confidence: number; reason: string }> };
}

const fixtures = history as unknown as Record<string, Fixture>;

const SUPPLIERS = {
  highland: { name: 'Highland Green Coffee Traders Pty Ltd', abn: '58607182954' },
  riverbend: { name: 'Riverbend Dairy Co-operative', abn: '88481093375' },
  packwell: { name: 'Packwell Packaging Pty Ltd', abn: '92152774106' },
  crema: { name: 'Crema Tech Espresso Services', abn: '25329815462' },
};

type Plan = {
  fixture: string;
  supplier: keyof typeof SUPPLIERS;
  status: InvoiceStatus;
  /** Final account per line where the reviewer overrode the AI. */
  overrides?: Record<number, string>;
  sync?: Array<{ step: string; request: string; status: number | null; outcome: string; detail: string; ms: number }>;
  error?: string;
};

const PLANS: Plan[] = [
  {
    fixture: 'hgc-24690',
    supplier: 'highland',
    status: 'posted',
    sync: [
      { step: 'post', request: 'POST /Purchase/Bill/Service', status: 403, outcome: 'retry', detail: 'MYOB rate limit (Developer Over Qps)', ms: 212 },
      { step: 'post', request: 'POST /Purchase/Bill/Service', status: 201, outcome: 'ok', detail: 'Created bill', ms: 388 },
    ],
  },
  { fixture: 'pw-50177', supplier: 'packwell', status: 'posted', sync: [{ step: 'post', request: 'POST /Purchase/Bill/Service', status: 201, outcome: 'ok', detail: 'Created bill', ms: 341 }] },
  {
    fixture: 'ct-3302',
    supplier: 'crema',
    status: 'failed',
    overrides: { 4: '6-1900' },
    error: 'MYOB rejected the bill: Line 4: account 6-1900 Equipment Hire is inactive.',
    sync: [{ step: 'post', request: 'POST /Purchase/Bill/Service', status: 400, outcome: 'fatal', detail: 'Line 4: account 6-1900 Equipment Hire is inactive.', ms: 297 }],
  },
  { fixture: 'rbd-00905', supplier: 'riverbend', status: 'posted', sync: [{ step: 'post', request: 'POST /Purchase/Bill/Service', status: 201, outcome: 'ok', detail: 'Created bill', ms: 305 }] },
  { fixture: 'rbd-00911', supplier: 'riverbend', status: 'needs_review' },
];

const at = (date: string, hhmm: string, plusMinutes = 0) => new Date(new Date(`${date}T${hhmm}:00+11:00`).getTime() + plusMinutes * 60_000).toISOString();
const dayAfter = (date: string) => new Date(new Date(`${date}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);

export async function seedWorkspace(tx: Sql, workspaceId: string, companyFileId: string) {
  const accounts = new Map((await tx<{ code: string; myob_uid: string; name: string }[]>`select code, myob_uid, name from accounts`).map((a) => [a.code, a]));
  const taxes = new Map((await tx<{ code: string; myob_uid: string; rate: number }[]>`select code, myob_uid, rate from tax_codes`).map((t) => [t.code, t]));

  // Writes are queued and sent together: postgres.js pipelines them on the transaction's
  // connection, so seeding costs a couple of round trips instead of ~60.
  const q: Array<PromiseLike<unknown>> = [];

  // Suppliers exist in both the app and MYOB, linked by UID.
  const supplierIds: Record<string, { id: string; myob: string }> = {};
  for (const [key, s] of Object.entries(SUPPLIERS)) {
    const myob = randomUUID();
    const id = randomUUID();
    q.push(tx`insert into myob_suppliers (uid, company_file_id, name, abn) values (${myob}::uuid, ${companyFileId}::uuid, ${s.name}, ${s.abn})`);
    q.push(tx`insert into suppliers (id, workspace_id, name, abn, myob_uid) values (${id}::uuid, ${workspaceId}::uuid, ${s.name}, ${s.abn}, ${myob}::uuid)`);
    supplierIds[key] = { id, myob };
  }

  let billNo = 180;
  const nextBillNo = () => String(++billNo).padStart(8, '0');

  const insertBill = (opts: {
    supplierUid: string;
    number: string | null;
    date: string;
    lines: Array<{ description: string; total: number; account: string; tax: string }>;
    source: 'api' | 'manual';
    comment: string;
    createdAt: string;
  }) => {
    const lines = opts.lines.map((l) => {
      const a = accounts.get(l.account)!;
      const t = taxes.get(l.tax)!;
      return { description: l.description, total: l.total, account_uid: a.myob_uid, account_code: a.code, account_name: a.name, tax_uid: t.myob_uid, tax_code: t.code, rate: Number(t.rate) };
    });
    const subtotal = cents(lines.reduce((s, l) => s + l.total, 0));
    const tax = cents(lines.reduce((s, l) => s + cents((l.total * l.rate) / 100), 0));
    const uid = randomUUID();
    q.push(tx`
      insert into myob_bills (uid, company_file_id, number, supplier_uid, supplier_invoice_number, date, subtotal, tax, total, lines, comment, source, created_at)
      values (${uid}::uuid, ${companyFileId}::uuid, ${nextBillNo()}, ${opts.supplierUid}::uuid, ${opts.number}, ${opts.date},
              ${subtotal}, ${tax}, ${cents(subtotal + tax)}, ${tx.json(lines.map(({ rate: _r, ...l }) => l) as never)}, ${opts.comment}, ${opts.source}, ${opts.createdAt})`);
    return uid;
  };

  for (const plan of PLANS) {
    const f = fixtures[plan.fixture];
    const v = f.extracted.values;
    const sup = supplierIds[plan.supplier];
    const invoiceDate = v.invoice_date as string;
    const created = at(dayAfter(invoiceDate), '09:12');
    const id = randomUUID();

    const lines = f.extracted.lines.map((l, i) => {
      const c = f.coded.lines.find((x) => x.position === i + 1)!;
      return { ...l, position: i + 1, ai: c, account_code: plan.overrides?.[i + 1] ?? c.account_code, tax_code: c.tax_code };
    });

    let billUid: string | null = null;
    if (plan.status === 'posted') {
      const billLines = lines.map((l) => ({ description: l.description, total: l.amount, account: l.account_code, tax: l.tax_code }));
      // Packwell's bill was later edited in MYOB: someone added a freight line.
      if (plan.fixture === 'pw-50177') billLines.push({ description: 'Freight (added in MYOB)', total: 40, account: '5-1400', tax: 'GST' });
      billUid = insertBill({ supplierUid: sup.myob, number: v.invoice_number as string, date: invoiceDate, lines: billLines, source: 'api', comment: `InvoicePilot ${id}`, createdAt: at(dayAfter(invoiceDate), '10:05') });
    }

    q.push(tx`
      insert into invoices (id, workspace_id, status, file_name, file_mime, file_size, file_sha256, file_url,
        supplier_id, supplier_name, supplier_abn, invoice_number, invoice_date, due_date, po_number, currency,
        subtotal, tax, total, confidence, boxes, pages, raw_vendor, extract_ms, code_ms, ai_tokens, ai_notes,
        myob_bill_uid, posted_at, last_error, created_at, updated_at)
      values (${id}::uuid, ${workspaceId}::uuid, ${plan.status}, ${plan.fixture + '.pdf'}, 'application/pdf', ${f.size}, ${'seed:' + plan.fixture}, ${f.file},
        ${sup.id}::uuid, ${SUPPLIERS[plan.supplier].name}, ${SUPPLIERS[plan.supplier].abn}, ${v.invoice_number}, ${invoiceDate}, ${v.due_date}, ${v.po_number}, ${v.currency ?? 'AUD'},
        ${v.subtotal}, ${v.tax}, ${v.total}, ${tx.json(f.extracted.confidence as never)}, ${tx.json(f.extracted.boxes as never)}, ${tx.json(f.extracted.pages as never)},
        ${f.extracted.raw_vendor}, ${f.extract_ms}, ${f.coded.ms}, ${f.coded.tokens}, ${f.coded.notes || null},
        ${billUid}::uuid, ${billUid ? at(dayAfter(invoiceDate), '10:05') : null}, ${plan.error ?? null}, ${created}, ${created})`);

    for (const l of lines) {
      q.push(tx`
        insert into invoice_lines (invoice_id, position, description, quantity, unit_price, amount, tax_code, account_code,
          ai_account_code, ai_tax_code, ai_confidence, ai_reason, read_confidence, box, tax_hint)
        values (${id}::uuid, ${l.position}, ${l.description}, ${l.quantity}, ${l.unit_price}, ${l.amount}, ${l.tax_code}, ${l.account_code},
          ${l.ai.account_code}, ${l.ai.tax_code}, ${l.ai.confidence}, ${l.ai.reason}, ${l.read_confidence}, ${l.box ? tx.json(l.box as never) : null}, ${l.tax_hint})`);
    }

    const events: Array<[string, string, number]> = [
      ['uploaded', `Uploaded ${plan.fixture}.pdf (${Math.ceil(f.size / 1024)} KB).`, 0],
      ['extracted', `Read ${lines.length} lines with Azure Document Intelligence in ${(f.extract_ms / 1000).toFixed(1)}s.`, 0.2],
      ['coded', `Azure OpenAI coded ${lines.length} lines in ${(f.coded.ms / 1000).toFixed(1)}s.`, 0.3],
    ];
    if (plan.status !== 'needs_review') {
      const changed = Object.keys(plan.overrides ?? {}).length;
      events.push(['approved', changed ? `Approved. The reviewer changed ${changed} of ${lines.length} AI suggestions.` : `Approved with all ${lines.length} AI suggestions kept.`, 48]);
      events.push(['post_queued', 'Queued for posting to MYOB.', 53]);
      if (plan.status === 'posted') events.push(['posted', `Posted to MYOB as a bill${(plan.sync?.length ?? 1) > 1 ? ` after ${plan.sync!.length} attempts` : ''}.`, 53.5]);
      if (plan.status === 'failed') events.push(['post_failed', plan.error!, 53.5]);
    }
    for (const [kind, message, minutes] of events) {
      q.push(tx`insert into events (invoice_id, kind, message, at) values (${id}::uuid, ${kind}, ${message}, ${at(dayAfter(invoiceDate), '09:12', minutes)})`);
    }

    if (plan.sync) {
      const jobId = randomUUID();
      const state = plan.status === 'posted' ? 'succeeded' : 'failed';
      q.push(tx`
        insert into sync_jobs (id, invoice_id, workspace_id, state, attempts, last_error, created_at, updated_at)
        values (${jobId}::uuid, ${id}::uuid, ${workspaceId}::uuid, ${state}, ${plan.sync.length}, ${plan.error ?? null}, ${at(dayAfter(invoiceDate), '10:05')}, ${at(dayAfter(invoiceDate), '10:05')})`);
      for (const [i, s] of plan.sync.entries()) {
        q.push(tx`
          insert into sync_attempts (job_id, attempt, step, request, status, outcome, detail, duration_ms, at)
          values (${jobId}::uuid, ${i + 1}, ${s.step}, ${s.request}, ${s.status}, ${s.outcome}, ${s.detail}, ${s.ms}, ${at(dayAfter(invoiceDate), '10:05', i * 0.02)})`);
      }
    }

    // Drift that reconciliation should catch.
    if (plan.fixture === 'hgc-24690') {
      // An old bulk-import script posted the same invoice again.
      insertBill({
        supplierUid: sup.myob,
        number: v.invoice_number as string,
        date: invoiceDate,
        lines: lines.map((l) => ({ description: l.description, total: l.amount, account: l.account_code, tax: l.tax_code })),
        source: 'api',
        comment: 'Imported by bulk-import.ps1',
        createdAt: at(dayAfter(invoiceDate), '23:40'),
      });
    }
  }

  // A bill a bookkeeper typed straight into MYOB.
  const gridline = randomUUID();
  q.push(tx`insert into myob_suppliers (uid, company_file_id, name, abn) values (${gridline}::uuid, ${companyFileId}::uuid, 'Gridline Energy Pty Ltd', null)`);
  insertBill({
    supplierUid: gridline,
    number: 'GE-0091822',
    date: '2026-10-31',
    lines: [{ description: 'Electricity — roastery, October', total: 1167.91, account: '6-1300', tax: 'GST' }],
    source: 'manual',
    comment: 'Entered manually',
    createdAt: at('2026-11-02', '15:20'),
  });

  await Promise.all(q);
}
