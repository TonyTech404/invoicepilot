// Integration test: the real sync worker against the mock MYOB, in Postgres.
// Runs when DATABASE_URL is set (CI uses a dedicated Neon branch).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db.js';
import { createWorkspace, deleteWorkspace, updateSettings, type Workspace } from '../src/session.js';
import { approveInvoice, getInvoice, listInvoices, patchInvoice, postInvoice } from '../src/invoices.js';
import { reconcile } from '../src/reconcile.js';

const enabled = !!process.env.DATABASE_URL;

describe.skipIf(!enabled)('posting to MYOB when responses get lost', () => {
  let ws: Workspace;

  beforeAll(async () => {
    ws = await createWorkspace(`test-${Date.now()}`);
  }, 30_000);

  afterAll(async () => {
    if (ws) await deleteWorkspace(ws.id);
    await db().end();
  });

  const billsFor = async (number: string) =>
    (await db()`select uid from myob_bills where company_file_id = ${ws.company_file_id}::uuid and supplier_invoice_number = ${number}`).length;

  it('with the guard on, a lost response does not create a duplicate', async () => {
    await updateSettings(ws.id, { myob_mode: 'lost_responses', idempotency_guard: true });
    const target = (await listInvoices(ws.id)).find((i) => i.invoice_number === 'INV-00911')!;
    await approveInvoice(ws.id, target.id);
    const posted = await postInvoice(ws.id, target.id);

    expect(posted.status).toBe('posted');
    expect(posted.sync?.log.map((a) => a.outcome)).toEqual(['uncertain', 'found']);
    expect(posted.events.at(-1)?.kind).toBe('post_found_existing');
    expect(await billsFor('INV-00911')).toBe(1);
  }, 30_000);

  it('with the guard off, the retry posts a second bill and reconciliation catches it', async () => {
    await updateSettings(ws.id, { myob_mode: 'lost_responses', idempotency_guard: false });
    const failed = (await listInvoices(ws.id)).find((i) => i.invoice_number === 'CT-3302')!;
    const detail = await getInvoice(ws.id, failed.id);
    const hire = detail.lines.find((l) => l.account_code === '6-1900')!;
    await patchInvoice(ws.id, failed.id, { lines: [{ id: hire.id, account_code: '6-1100' }] });
    await approveInvoice(ws.id, failed.id);
    const posted = await postInvoice(ws.id, failed.id);

    expect(posted.status).toBe('posted');
    expect(await billsFor('CT-3302')).toBe(2);

    const report = await reconcile(ws.id);
    const row = report.rows.find((r) => r.supplier_invoice_number === 'CT-3302')!;
    expect(row.kind).toBe('duplicate_in_myob');
  }, 30_000);

  it('MYOB rejects an inactive account, and the job fails without retrying', async () => {
    await updateSettings(ws.id, { myob_mode: 'healthy', idempotency_guard: true });
    const id = (await listInvoices(ws.id)).find((i) => i.invoice_number === 'INV-00905')!.id;
    // Force the seeded, posted invoice back through a post with a closed account.
    await db()`update invoices set status = 'approved', myob_bill_uid = null where id = ${id}::uuid`;
    await db()`update invoice_lines set account_code = '6-1900' where invoice_id = ${id}::uuid and position = 1`;
    await db()`update sync_jobs set state = 'failed' where invoice_id = ${id}::uuid`;
    const result = await postInvoice(ws.id, id);

    expect(result.status).toBe('failed');
    expect(result.last_error).toMatch(/inactive/);
    expect(result.sync?.log.at(-1)?.outcome).toBe('fatal');
  }, 30_000);
});
