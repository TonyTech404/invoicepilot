// Posts approved invoices to MYOB as bills.
//
// Each invoice gets one row in sync_jobs (an outbox). A job is claimed with a short lock so two
// clicks or two workers never post the same bill at once. Failures are sorted into:
//   - safe to retry (rate limit, 503): back off and try again
//   - uncertain (timeout, other 5xx): MYOB may have saved the bill. Before posting again,
//     look it up by supplier invoice number. MYOB has no idempotency keys, so this lookup is
//     the only thing standing between a dropped connection and paying a supplier twice.
//   - fatal (400 validation): stop and hand it back to a person.
import { db, type Sql } from './db.js';
import { addEvent } from './events.js';
import { MyobError, type MyobClient } from './myob/client.js';
import { myobClientFor } from './myob/transport.js';
import { cents, differs } from './lib/money.js';
import type { MyobMode } from '../../shared/types.js';

export const MAX_ATTEMPTS = 6;
const INLINE_BUDGET_MS = 12_000;

export type JobOutcome = 'succeeded' | 'retrying' | 'failed' | 'busy';

export function backoffMs(attempt: number, random = Math.random()): number {
  const base = Math.min(8000, 500 * 2 ** (attempt - 1));
  return Math.round(base * (0.75 + random * 0.5));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Queues an approved invoice for posting. Re-queues a failed one. */
export async function enqueuePost(sql: Sql, invoiceId: string, workspaceId: string): Promise<string> {
  const [job] = await sql<{ id: string }[]>`
    insert into sync_jobs (invoice_id, workspace_id)
    values (${invoiceId}::uuid, ${workspaceId}::uuid)
    on conflict (invoice_id) do update
      set state = 'pending', attempts = 0, next_attempt_at = now(), last_error = null, locked_until = null, updated_at = now()
      where sync_jobs.state = 'failed'
    returning id`;
  if (job) {
    await sql`update invoices set status = 'posting', last_error = null, updated_at = now() where id = ${invoiceId}::uuid`;
    await addEvent(sql, invoiceId, 'post_queued', 'Queued for posting to MYOB.');
    return job.id;
  }
  const [existing] = await sql<{ id: string }[]>`select id from sync_jobs where invoice_id = ${invoiceId}::uuid`;
  return existing.id;
}

interface JobContext {
  job: { id: string; invoice_id: string; attempts: number; uncertain: boolean };
  ws: { company_file_id: string; myob_mode: MyobMode; idempotency_guard: boolean };
  invoice: { invoice_number: string; invoice_date: string; total: number; tax: number; supplier_id: string };
  supplier: { id: string; name: string; abn: string | null; myob_uid: string | null };
  lines: Array<{ description: string; amount: number; account_uid: string; tax_uid: string }>;
}

async function claim(sql: Sql, jobId: string): Promise<JobContext | null> {
  const [job] = await sql<JobContext['job'][]>`
    update sync_jobs set locked_until = now() + interval '60 seconds', updated_at = now()
    where id = ${jobId}::uuid and state in ('pending', 'retrying')
      and (locked_until is null or locked_until < now())
    returning id, invoice_id, attempts, uncertain`;
  if (!job) return null;

  const [row] = await sql<Array<JobContext['invoice'] & JobContext['ws'] & { s_name: string; s_abn: string | null; s_uid: string | null }>>`
    select i.invoice_number, i.invoice_date, i.total, i.tax, i.supplier_id,
           w.company_file_id, w.myob_mode, w.idempotency_guard,
           s.name as s_name, s.abn as s_abn, s.myob_uid as s_uid
    from invoices i
    join workspaces w on w.id = i.workspace_id
    join suppliers s on s.id = i.supplier_id
    where i.id = ${job.invoice_id}::uuid`;
  const lines = await sql<JobContext['lines']>`
    select l.description, l.amount, a.myob_uid as account_uid, t.myob_uid as tax_uid
    from invoice_lines l
    join accounts a on a.code = l.account_code
    join tax_codes t on t.code = l.tax_code
    where l.invoice_id = ${job.invoice_id}::uuid
    order by l.position`;

  return {
    job,
    ws: { company_file_id: row.company_file_id, myob_mode: row.myob_mode, idempotency_guard: row.idempotency_guard },
    invoice: { invoice_number: row.invoice_number, invoice_date: row.invoice_date, total: row.total, tax: row.tax, supplier_id: row.supplier_id },
    supplier: { id: row.supplier_id, name: row.s_name, abn: row.s_abn, myob_uid: row.s_uid },
    lines,
  };
}

/** Runs one job until it succeeds, fails for good, or runs out of time for this request. */
export async function runJob(jobId: string, opts: { budgetMs?: number; client?: MyobClient } = {}): Promise<JobOutcome> {
  const sql = db();
  const ctx = await claim(sql, jobId);
  if (!ctx) return 'busy';

  const { job, ws, invoice, supplier, lines } = ctx;
  const client = opts.client ?? myobClientFor(ws);
  const started = Date.now();
  const budget = opts.budgetMs ?? INLINE_BUDGET_MS;
  let attempts = job.attempts;
  let uncertain = job.uncertain;

  const log = async (step: string, request: string, status: number | null, outcome: string, detail: string | null, since: number) => {
    await sql`insert into sync_attempts (job_id, attempt, step, request, status, outcome, detail, duration_ms)
              values (${job.id}::uuid, ${attempts}, ${step}, ${request}, ${status}, ${outcome}, ${detail}, ${Date.now() - since})`;
  };

  const succeed = async (billUid: string, found: boolean) => {
    await sql.begin(async (tx) => {
      await tx`update sync_jobs set state = 'succeeded', attempts = ${attempts}, uncertain = false, locked_until = null, last_error = null, updated_at = now() where id = ${job.id}::uuid`;
      await tx`update invoices set status = 'posted', myob_bill_uid = ${billUid}::uuid, posted_at = now(), last_error = null, updated_at = now() where id = ${job.invoice_id}::uuid`;
      await addEvent(
        tx,
        job.invoice_id,
        found ? 'post_found_existing' : 'posted',
        found
          ? 'Found this bill already in MYOB from an earlier attempt whose response was lost. Linked it instead of posting a second copy.'
          : `Posted to MYOB as a bill${attempts > 1 ? ` after ${attempts} attempts` : ''}.`,
        { bill_uid: billUid },
      );
    });
  };

  while (true) {
    attempts += 1;
    let step = 'lookup';
    let request = '';
    let since = Date.now();
    try {
      // 1. An earlier attempt may have reached MYOB. Look before posting again.
      if (uncertain && supplier.myob_uid) {
        if (ws.idempotency_guard) {
          step = 'lookup';
          request = `GET /Purchase/Bill/Service?$filter=SupplierInvoiceNumber eq '${invoice.invoice_number}'`;
          since = Date.now();
          const found = await client.findBills(supplier.myob_uid, invoice.invoice_number);
          await log(step, request, 200, found.length ? 'found' : 'ok', found.length ? `Bill ${found[0].Number} already exists` : 'Not in MYOB, safe to post', since);
          if (found.length) {
            await succeed(found[0].UID, true);
            return 'succeeded';
          }
        } else {
          await addEvent(sql, job.invoice_id, 'guard_off', 'Retrying after a lost response without checking MYOB first (duplicate guard is off).');
        }
        uncertain = false;
      }

      // 2. Make sure the supplier exists in MYOB. Look up by ABN first so a retry never creates a second card.
      if (!supplier.myob_uid) {
        step = 'supplier';
        if (supplier.abn) {
          request = `GET /Contact/Supplier?$filter=BuyingDetails/ABN eq '${supplier.abn}'`;
          since = Date.now();
          supplier.myob_uid = await client.findSupplierByAbn(supplier.abn);
          await log(step, request, 200, 'ok', supplier.myob_uid ? 'Supplier already in MYOB' : 'Supplier not in MYOB yet', since);
        }
        if (!supplier.myob_uid) {
          request = 'POST /Contact/Supplier';
          since = Date.now();
          supplier.myob_uid = await client.createSupplier(supplier.name, supplier.abn);
          await log(step, request, 201, 'ok', `Created supplier card for ${supplier.name}`, since);
          await addEvent(sql, job.invoice_id, 'supplier_created', `Created ${supplier.name} as a new supplier in MYOB.`);
        }
        await sql`update suppliers set myob_uid = ${supplier.myob_uid}::uuid where id = ${supplier.id}::uuid`;
      }

      // 3. Post the bill.
      step = 'post';
      request = 'POST /Purchase/Bill/Service';
      since = Date.now();
      const billUid = await client.createBill({
        date: invoice.invoice_date,
        supplierUid: supplier.myob_uid,
        supplierInvoiceNumber: invoice.invoice_number,
        comment: `InvoicePilot ${job.invoice_id}`,
        lines: lines.map((l) => ({ description: l.description, total: l.amount, accountUid: l.account_uid, taxCodeUid: l.tax_uid })),
      });
      await log(step, request, 201, 'ok', `Created bill ${billUid.slice(0, 8)}`, since);
      await succeed(billUid, false);

      // 4. Read it back. MYOB works out GST per line, so it can land a cent away from the paper.
      try {
        const bill = await client.getBill(billUid);
        if (differs(bill.TotalTax, invoice.tax, 0.001)) {
          await addEvent(sql, job.invoice_id, 'gst_rounding', `MYOB calculated GST of $${bill.TotalTax.toFixed(2)}; the invoice says $${cents(invoice.tax).toFixed(2)}. Adjust in MYOB if your bookkeeper wants it to match the paper.`);
        }
      } catch {
        // The bill is posted. A failed read-back is not worth failing the job over.
      }
      return 'succeeded';
    } catch (err) {
      if (!(err instanceof MyobError)) throw err;
      const outcome = !err.transient ? 'fatal' : err.uncertain && step !== 'lookup' ? 'uncertain' : 'retry';
      await log(step, request, err.status, outcome, err.message, since);
      if (err.uncertain && step === 'post') uncertain = true;

      if (!err.transient || attempts >= MAX_ATTEMPTS) {
        const reason = !err.transient ? `MYOB rejected the bill: ${err.message}` : `Gave up after ${attempts} attempts: ${err.message}`;
        await sql.begin(async (tx) => {
          await tx`update sync_jobs set state = 'failed', attempts = ${attempts}, uncertain = ${uncertain}, locked_until = null, last_error = ${reason}, updated_at = now() where id = ${job.id}::uuid`;
          await tx`update invoices set status = 'failed', last_error = ${reason}, updated_at = now() where id = ${job.invoice_id}::uuid`;
          await addEvent(tx, job.invoice_id, 'post_failed', reason);
        });
        return 'failed';
      }

      const wait = backoffMs(attempts);
      if (Date.now() - started + wait > budget) {
        // Out of time for this request; the scheduled worker picks it up.
        const retryIn = Math.max(wait, 15_000);
        await sql`update sync_jobs set state = 'retrying', attempts = ${attempts}, uncertain = ${uncertain}, locked_until = null,
                    last_error = ${err.message}, next_attempt_at = now() + ${retryIn} * interval '1 millisecond', updated_at = now()
                  where id = ${job.id}::uuid`;
        await addEvent(sql, job.invoice_id, 'post_retry', `MYOB did not accept it yet (${err.message}). Will retry automatically.`);
        return 'retrying';
      }
      await sql`update sync_jobs set attempts = ${attempts}, uncertain = ${uncertain}, last_error = ${err.message}, updated_at = now() where id = ${job.id}::uuid`;
      await sleep(wait);
    }
  }
}

/** Runs jobs that are due. Called by the scheduled GitHub Action and the "Run sync now" button. */
export async function runDueJobs(opts: { workspaceId?: string; limit?: number; budgetMs?: number } = {}) {
  const sql = db();
  const due = await sql<{ id: string }[]>`
    select id from sync_jobs
    where state in ('pending', 'retrying') and next_attempt_at <= now()
      and (${opts.workspaceId ?? null}::uuid is null or workspace_id = ${opts.workspaceId ?? null}::uuid)
    order by next_attempt_at
    limit ${opts.limit ?? 10}`;
  const results: Record<JobOutcome, number> = { succeeded: 0, retrying: 0, failed: 0, busy: 0 };
  for (const { id } of due) results[await runJob(id, { budgetMs: opts.budgetMs ?? 6000 })] += 1;
  return { ran: due.length, ...results };
}
