// The invoice pipeline: upload -> extract (Document Intelligence) -> code (Azure OpenAI)
// -> review -> approve -> post (sync.ts).
import { createHash } from 'node:crypto';
import { db, type Sql } from './db.js';
import { addEvent } from './events.js';
import { analyzeInvoice, mapInvoice, type DiResult } from './docintel.js';
import { codeLines, type PastCoding } from './coding.js';
import { runChecks, hasErrors } from './checks.js';
import { normaliseAbn } from './lib/abn.js';
import { cents } from './lib/money.js';
import { allow } from './ratelimit.js';
import { env } from './env.js';
import { enqueuePost, runJob } from './sync.js';
import type { Account, Check, Invoice, InvoiceLine, InvoicePatch, InvoiceStatus, InvoiceSummary, Stats, SyncJob } from '../../shared/types.js';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export const ACCEPTED_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/tiff', 'image/bmp'];
export const MAX_BYTES = 4 * 1024 * 1024;

const EDITABLE: InvoiceStatus[] = ['extracted', 'needs_review', 'failed'];

// ── Reads ───────────────────────────────────────────────────────────────────

export async function listAccounts(sql: Sql = db()): Promise<Account[]> {
  return sql<Account[]>`select code, name, kind, default_tax_code, description, active from accounts order by code`;
}

async function loadInvoiceRow(sql: Sql, workspaceId: string, id: string) {
  const [row] = await sql`
    select i.*, (i.supplier_id is not null) as supplier_known
    from invoices i
    where i.id = ${id}::uuid and i.workspace_id = ${workspaceId}::uuid`;
  if (!row) throw new HttpError(404, 'Invoice not found');
  return row;
}

async function loadLines(sql: Sql, invoiceId: string): Promise<InvoiceLine[]> {
  return sql<InvoiceLine[]>`
    select id, position, description, quantity, unit_price, amount, tax_code, account_code,
           ai_account_code, ai_tax_code, ai_confidence, ai_reason, read_confidence, box
    from invoice_lines where invoice_id = ${invoiceId}::uuid order by position`;
}

export async function getInvoice(workspaceId: string, id: string): Promise<Invoice> {
  const sql = db();
  const row = await loadInvoiceRow(sql, workspaceId, id);
  const [lines, events, jobRows] = await Promise.all([
    loadLines(sql, id),
    sql<{ at: string; kind: string; message: string }[]>`select at, kind, message from events where invoice_id = ${id}::uuid order by at, id`,
    sql`select id, state, attempts, uncertain, next_attempt_at, last_error from sync_jobs where invoice_id = ${id}::uuid`,
  ]);

  let sync: SyncJob | null = null;
  if (jobRows[0]) {
    const job = jobRows[0];
    const log = await sql`select at, attempt, step, request, status, outcome, detail, duration_ms from sync_attempts where job_id = ${job.id}::uuid order by at, id`;
    sync = { state: job.state, attempts: job.attempts, uncertain: job.uncertain, next_attempt_at: job.next_attempt_at, last_error: job.last_error, log: log as never };
  }

  const checks = row.checks as Check[];
  return {
    id: row.id,
    status: row.status,
    file_name: row.file_name,
    file_mime: row.file_mime,
    file_url: row.file_url ?? `/api/invoices/${row.id}/file`,
    supplier_id: row.supplier_id,
    supplier_name: row.supplier_name,
    supplier_abn: row.supplier_abn,
    supplier_known: row.supplier_known,
    invoice_number: row.invoice_number,
    invoice_date: row.invoice_date,
    due_date: row.due_date,
    po_number: row.po_number,
    currency: row.currency,
    subtotal: row.subtotal,
    tax: row.tax,
    total: row.total,
    confidence: row.confidence,
    boxes: row.boxes,
    pages: row.pages,
    raw_vendor: row.raw_vendor,
    extract_ms: row.extract_ms,
    code_ms: row.code_ms,
    ai_tokens: row.ai_tokens,
    ai_notes: row.ai_notes,
    myob_bill_uid: row.myob_bill_uid,
    posted_at: row.posted_at,
    last_error: row.last_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
    errors: checks.filter((c) => c.level === 'error').length,
    warnings: checks.filter((c) => c.level === 'warning').length,
    lines,
    checks,
    events,
    sync,
  };
}

export async function listInvoices(workspaceId: string): Promise<InvoiceSummary[]> {
  return db()<InvoiceSummary[]>`
    select id, status, file_name, supplier_name, invoice_number, invoice_date, due_date, total, currency, created_at, updated_at,
           (select count(*)::int from jsonb_array_elements(checks) c where c->>'level' = 'error') as errors,
           (select count(*)::int from jsonb_array_elements(checks) c where c->>'level' = 'warning') as warnings
    from invoices where workspace_id = ${workspaceId}::uuid
    order by created_at desc
    limit 200`;
}

export async function getStats(workspaceId: string): Promise<Stats> {
  const sql = db();
  const statusRows = await sql<{ status: InvoiceStatus; n: number }[]>`
    select status, count(*)::int as n from invoices where workspace_id = ${workspaceId}::uuid group by status`;
  const counts = Object.fromEntries(
    (['uploaded', 'extracted', 'needs_review', 'approved', 'posting', 'posted', 'failed', 'rejected'] as InvoiceStatus[]).map((s) => [s, 0]),
  ) as Record<InvoiceStatus, number>;
  for (const r of statusRows) counts[r.status] = r.n;

  const [agg] = await sql<{ approved_value: number; posted_value: number; avg_extract_ms: number | null }[]>`
    select coalesce(sum(total) filter (where status in ('approved', 'posting')), 0)::float8 as approved_value,
           coalesce(sum(total) filter (where status = 'posted'), 0)::float8 as posted_value,
           avg(extract_ms)::float8 as avg_extract_ms
    from invoices where workspace_id = ${workspaceId}::uuid`;
  const [ai] = await sql<{ kept: number; total: number }[]>`
    select count(*) filter (where l.account_code = l.ai_account_code)::int as kept, count(*)::int as total
    from invoice_lines l join invoices i on i.id = l.invoice_id
    where i.workspace_id = ${workspaceId}::uuid and l.ai_account_code is not null and i.status in ('approved', 'posting', 'posted', 'failed')`;

  return {
    counts,
    approved_value: agg.approved_value,
    posted_value: agg.posted_value,
    avg_extract_ms: agg.avg_extract_ms,
    ai_accept_rate: ai.total ? ai.kept / ai.total : null,
  };
}

export async function getFile(workspaceId: string, id: string) {
  const [row] = await db()<{ file_mime: string; file_name: string; bytes: Uint8Array }[]>`
    select i.file_mime, i.file_name, f.bytes from invoices i join invoice_files f on f.invoice_id = i.id
    where i.id = ${id}::uuid and i.workspace_id = ${workspaceId}::uuid`;
  if (!row) throw new HttpError(404, 'File not found');
  return row;
}

// ── Checks ──────────────────────────────────────────────────────────────────

export async function refreshChecks(sql: Sql, workspaceId: string, id: string): Promise<Check[]> {
  const row = await loadInvoiceRow(sql, workspaceId, id);
  const lines = await loadLines(sql, id);
  const accounts = await listAccounts(sql);

  let duplicateOf = null;
  if (row.invoice_number) {
    const [dup] = await sql<{ invoice_number: string; status: string; created_at: string }[]>`
      select invoice_number, status, created_at from invoices
      where workspace_id = ${workspaceId}::uuid and id <> ${id}::uuid and status <> 'rejected'
        and lower(invoice_number) = lower(${row.invoice_number})
        and (supplier_id = ${row.supplier_id ?? null}::uuid
             or (supplier_abn is not null and supplier_abn = ${row.supplier_abn ?? null})
             or lower(supplier_name) = lower(${row.supplier_name ?? ''}))
        and created_at < ${row.created_at}
      order by created_at limit 1`;
    duplicateOf = dup ?? null;
  }

  const checks = runChecks({
    ...row,
    supplier_known: row.supplier_known,
    confidence: row.confidence,
    lines,
    accounts,
    duplicateOf,
    today: new Date().toISOString().slice(0, 10),
  } as never);
  await sql`update invoices set checks = ${sql.json(checks as never)} where id = ${id}::uuid`;
  return checks;
}

// ── Pipeline steps ──────────────────────────────────────────────────────────

export async function createInvoice(workspaceId: string, ip: string, file: { name: string; type: string; bytes: Uint8Array }) {
  if (!ACCEPTED_TYPES.includes(file.type)) throw new HttpError(415, 'Upload a PDF or a photo (JPEG or PNG).');
  if (file.bytes.byteLength > MAX_BYTES) throw new HttpError(413, 'Files up to 4 MB, please.');
  if (!(await allow(`upload:${ip}`, 3600, 20))) throw new HttpError(429, 'That is a lot of invoices. Try again in an hour.');

  const sha = createHash('sha256').update(file.bytes).digest('hex');
  const sql = db();
  const id = await sql.begin(async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      insert into invoices (workspace_id, file_name, file_mime, file_size, file_sha256)
      values (${workspaceId}::uuid, ${file.name.slice(0, 200)}, ${file.type}, ${file.bytes.byteLength}, ${sha})
      returning id`;
    await tx`insert into invoice_files (invoice_id, bytes) values (${row.id}::uuid, ${Buffer.from(file.bytes)})`;
    await addEvent(tx, row.id, 'uploaded', `Uploaded ${file.name} (${Math.ceil(file.bytes.byteLength / 1024)} KB).`);
    return row.id;
  });
  return { id };
}

export async function extractInvoice(workspaceId: string, id: string) {
  const sql = db();
  const row = await loadInvoiceRow(sql, workspaceId, id);
  if (!['uploaded', 'extracted'].includes(row.status)) throw new HttpError(409, 'This invoice has already been read.');

  const started = Date.now();
  let result: DiResult;
  let cached = false;
  const [hit] = await sql<{ result: DiResult }[]>`select result from extraction_cache where sha256 = ${row.file_sha256}`;
  if (hit) {
    result = hit.result;
    cached = true;
  } else {
    if (!(await allow('docintel:daily', 86400, env.dailyExtractLimit))) {
      throw new HttpError(429, 'The demo has used its free Document Intelligence pages for today. Try a sample invoice instead.');
    }
    const [file] = await sql<{ bytes: Uint8Array }[]>`select bytes from invoice_files where invoice_id = ${id}::uuid`;
    result = await analyzeInvoice(file.bytes);
    await sql`insert into extraction_cache (sha256, result) values (${row.file_sha256}, ${sql.json(result as never)}) on conflict do nothing`;
  }
  const ms = cached ? null : Date.now() - started;
  const x = mapInvoice(result);

  // Match a known supplier by ABN, then by name.
  const abn = normaliseAbn(x.values.supplier_abn as string | null);
  const [supplier] = await sql<{ id: string; name: string }[]>`
    select id, name from suppliers
    where workspace_id = ${workspaceId}::uuid
      and ((${abn}::text is not null and abn = ${abn}) or lower(name) = lower(${(x.values.supplier_name as string) ?? ''}))
    order by (abn = ${abn}) desc nulls last limit 1`;

  await sql.begin(async (tx) => {
    await tx`
      update invoices set
        status = 'extracted',
        supplier_id = ${supplier?.id ?? null}::uuid,
        supplier_name = ${supplier?.name ?? x.values.supplier_name},
        supplier_abn = ${abn},
        invoice_number = ${x.values.invoice_number},
        invoice_date = ${x.values.invoice_date},
        due_date = ${x.values.due_date},
        po_number = ${x.values.po_number},
        currency = ${x.values.currency},
        subtotal = ${x.values.subtotal},
        tax = ${x.values.tax},
        total = ${x.values.total},
        confidence = ${tx.json(x.confidence as never)},
        boxes = ${tx.json(x.boxes as never)},
        pages = ${tx.json(x.pages as never)},
        raw_vendor = ${x.raw_vendor},
        extract_ms = ${ms ?? row.extract_ms ?? null},
        updated_at = now()
      where id = ${id}::uuid`;
    await tx`delete from invoice_lines where invoice_id = ${id}::uuid`;
    for (const [i, l] of x.lines.entries()) {
      await tx`
        insert into invoice_lines (invoice_id, position, description, quantity, unit_price, amount, read_confidence, box, tax_hint)
        values (${id}::uuid, ${i + 1}, ${l.description}, ${l.quantity}, ${l.unit_price}, ${l.amount}, ${l.read_confidence},
                ${l.box ? tx.json(l.box as never) : null}, ${l.tax_hint})`;
    }
    await addEvent(
      tx,
      id,
      'extracted',
      cached
        ? `Read ${x.lines.length} lines with Azure Document Intelligence (cached result for this exact file).`
        : `Read ${x.lines.length} lines with Azure Document Intelligence in ${((ms ?? 0) / 1000).toFixed(1)}s.`,
    );
  });
  await refreshChecks(sql, workspaceId, id);
  return getInvoice(workspaceId, id);
}

export async function codeInvoice(workspaceId: string, id: string) {
  const sql = db();
  const row = await loadInvoiceRow(sql, workspaceId, id);
  if (row.status !== 'extracted') throw new HttpError(409, 'Read the invoice before coding it.');

  const lines = await sql<Array<InvoiceLine & { tax_hint: string | null }>>`
    select position, description, quantity, unit_price, amount, tax_hint from invoice_lines where invoice_id = ${id}::uuid order by position`;
  const accounts = await listAccounts(sql);
  const history = row.supplier_id
    ? await sql<PastCoding[]>`
        select distinct on (l.description) l.description, l.account_code, l.tax_code,
               (l.ai_account_code is not null and l.ai_account_code <> l.account_code) as corrected
        from invoice_lines l join invoices i on i.id = l.invoice_id
        where i.workspace_id = ${workspaceId}::uuid and i.supplier_id = ${row.supplier_id}::uuid and i.id <> ${id}::uuid
          and i.status in ('approved', 'posting', 'posted', 'failed') and l.account_code is not null
        order by l.description, i.created_at desc
        limit 30`
    : [];

  const result = await codeLines({
    supplier_name: row.supplier_name,
    raw_vendor: row.raw_vendor,
    invoice_total: row.total,
    invoice_tax: row.tax,
    accounts,
    history,
    lines: lines.map((l) => ({
      position: l.position,
      description: l.description,
      quantity: l.quantity,
      unit_price: l.unit_price,
      amount: l.amount,
      tax_hint: l.tax_hint,
    })),
  });

  await sql.begin(async (tx) => {
    for (const c of result.lines) {
      await tx`
        update invoice_lines set
          account_code = ${c.account_code}, tax_code = ${c.tax_code},
          ai_account_code = ${c.account_code}, ai_tax_code = ${c.tax_code},
          ai_confidence = ${c.confidence}, ai_reason = ${c.reason}
        where invoice_id = ${id}::uuid and position = ${c.position}`;
    }
    // A new supplier keeps the AI's cleaned-up name; a known one keeps the name on file.
    const name = row.supplier_id ? row.supplier_name : (result.supplier_name ?? row.supplier_name);
    await tx`
      update invoices set status = 'needs_review', supplier_name = ${name}, code_ms = ${result.ms},
             ai_tokens = ${result.tokens}, ai_notes = ${result.notes || null}, updated_at = now()
      where id = ${id}::uuid`;
    const sure = result.lines.filter((l) => l.confidence >= 0.75).length;
    await addEvent(
      tx,
      id,
      'coded',
      `Azure OpenAI coded ${result.lines.length} lines in ${(result.ms / 1000).toFixed(1)}s` +
        `${history.length ? `, using ${history.length} past codings for this supplier` : ''}. ${sure} of ${result.lines.length} with high confidence.`,
    );
  });
  await refreshChecks(sql, workspaceId, id);
  return getInvoice(workspaceId, id);
}

export async function patchInvoice(workspaceId: string, id: string, patch: InvoicePatch) {
  const sql = db();
  const row = await loadInvoiceRow(sql, workspaceId, id);
  if (!EDITABLE.includes(row.status)) throw new HttpError(409, `A ${row.status.replace('_', ' ')} invoice cannot be edited.`);

  const header = { ...patch };
  delete header.lines;
  const changedLines: string[] = [];

  await sql.begin(async (tx) => {
    if (Object.keys(header).length) {
      const v = {
        supplier_name: 'supplier_name' in header ? header.supplier_name : row.supplier_name,
        supplier_abn: 'supplier_abn' in header ? normaliseAbn(header.supplier_abn) : row.supplier_abn,
        invoice_number: 'invoice_number' in header ? header.invoice_number : row.invoice_number,
        invoice_date: 'invoice_date' in header ? header.invoice_date || null : row.invoice_date,
        due_date: 'due_date' in header ? header.due_date || null : row.due_date,
        po_number: 'po_number' in header ? header.po_number : row.po_number,
        subtotal: 'subtotal' in header ? (header.subtotal == null ? null : cents(header.subtotal)) : row.subtotal,
        tax: 'tax' in header ? (header.tax == null ? null : cents(header.tax)) : row.tax,
        total: 'total' in header ? (header.total == null ? null : cents(header.total)) : row.total,
      };
      // Editing the supplier name or ABN can change which supplier this is.
      let supplierId = row.supplier_id;
      if ('supplier_abn' in header || 'supplier_name' in header) {
        const [s] = await tx<{ id: string }[]>`
          select id from suppliers where workspace_id = ${workspaceId}::uuid
            and ((${v.supplier_abn}::text is not null and abn = ${v.supplier_abn}) or lower(name) = lower(${v.supplier_name ?? ''}))
          limit 1`;
        supplierId = s?.id ?? null;
      }
      await tx`
        update invoices set
          supplier_id = ${supplierId}::uuid, supplier_name = ${v.supplier_name}, supplier_abn = ${v.supplier_abn},
          invoice_number = ${v.invoice_number}, invoice_date = ${v.invoice_date}, due_date = ${v.due_date}, po_number = ${v.po_number},
          subtotal = ${v.subtotal}, tax = ${v.tax}, total = ${v.total}, updated_at = now()
        where id = ${id}::uuid`;
      // A person typed it, so it is no longer "low confidence".
      for (const k of Object.keys(header)) {
        await tx`update invoices set confidence = confidence - ${k} where id = ${id}::uuid`;
      }
    }
    for (const l of patch.lines ?? []) {
      const [before] = await tx<InvoiceLine[]>`select * from invoice_lines where id = ${l.id}::uuid and invoice_id = ${id}::uuid`;
      if (!before) continue;
      await tx`
        update invoice_lines set
          description = ${l.description ?? before.description},
          amount = ${l.amount != null ? cents(l.amount) : before.amount},
          tax_code = ${'tax_code' in l ? (l.tax_code ?? null) : before.tax_code},
          account_code = ${'account_code' in l ? (l.account_code ?? null) : before.account_code},
          read_confidence = ${l.description != null || l.amount != null ? null : before.read_confidence}
        where id = ${l.id}::uuid`;
      if ('account_code' in l && l.account_code !== before.account_code) changedLines.push(`line ${before.position} to ${l.account_code}`);
    }
    if (row.status === 'failed') {
      await tx`update invoices set status = 'needs_review', updated_at = now() where id = ${id}::uuid`;
    }
    if (changedLines.length) await addEvent(tx, id, 'recoded', `Reviewer changed ${changedLines.join(', ')}.`);
  });
  await refreshChecks(sql, workspaceId, id);
  return getInvoice(workspaceId, id);
}

export async function approveInvoice(workspaceId: string, id: string) {
  const sql = db();
  const row = await loadInvoiceRow(sql, workspaceId, id);
  if (row.status !== 'needs_review') throw new HttpError(409, 'Only invoices waiting for review can be approved.');
  const checks = await refreshChecks(sql, workspaceId, id);
  if (hasErrors(checks)) throw new HttpError(422, 'Fix the errors before approving.', { checks });

  await sql.begin(async (tx) => {
    let supplierId = row.supplier_id;
    if (!supplierId) {
      const [s] = await tx<{ id: string }[]>`
        insert into suppliers (workspace_id, name, abn) values (${workspaceId}::uuid, ${row.supplier_name}, ${row.supplier_abn})
        on conflict (workspace_id, abn) do update set name = excluded.name
        returning id`;
      supplierId = s.id;
    }
    const [{ changed, total }] = await tx<{ changed: number; total: number }[]>`
      select count(*) filter (where ai_account_code is not null and ai_account_code <> account_code)::int as changed, count(*)::int as total
      from invoice_lines where invoice_id = ${id}::uuid`;
    await tx`update invoices set status = 'approved', supplier_id = ${supplierId}::uuid, updated_at = now() where id = ${id}::uuid`;
    await addEvent(
      tx,
      id,
      'approved',
      changed
        ? `Approved. The reviewer changed ${changed} of ${total} AI suggestions; future invoices from this supplier will follow those changes.`
        : `Approved with all ${total} AI suggestions kept.`,
    );
  });
  await refreshChecks(sql, workspaceId, id);
  return getInvoice(workspaceId, id);
}

export async function rejectInvoice(workspaceId: string, id: string, reason: string) {
  const sql = db();
  const row = await loadInvoiceRow(sql, workspaceId, id);
  if (!['extracted', 'needs_review', 'approved', 'failed'].includes(row.status)) throw new HttpError(409, 'This invoice cannot be rejected now.');
  await sql`update invoices set status = 'rejected', updated_at = now() where id = ${id}::uuid`;
  await addEvent(sql, id, 'rejected', reason ? `Rejected: ${reason}` : 'Rejected.');
  return getInvoice(workspaceId, id);
}

export async function postInvoice(workspaceId: string, id: string) {
  const sql = db();
  const row = await loadInvoiceRow(sql, workspaceId, id);
  if (!['approved', 'failed', 'posting'].includes(row.status)) throw new HttpError(409, 'Approve the invoice before posting it.');
  const jobId = await enqueuePost(sql, id, workspaceId);
  await runJob(jobId);
  return getInvoice(workspaceId, id);
}
