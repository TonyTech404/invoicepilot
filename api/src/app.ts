// HTTP API. Runs on Azure Functions in production (functions.ts) and Node locally (dev.ts).
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { timingSafeEqual } from 'node:crypto';
import { db } from './db.js';
import { env } from './env.js';
import { ExtractionError } from './docintel.js';
import {
  HttpError,
  approveInvoice,
  codeInvoice,
  createInvoice,
  extractInvoice,
  getFile,
  getInvoice,
  getStats,
  listAccounts,
  listInvoices,
  patchInvoice,
  postInvoice,
  rejectInvoice,
} from './invoices.js';
import { reconcile } from './reconcile.js';
import { runDueJobs } from './sync.js';
import { myobMock, MOCK_BASE } from './myob/mock.js';
import { createWorkspace, deleteWorkspace, findWorkspace, pruneWorkspaces, updateSettings, type Workspace } from './session.js';
import type { InvoicePatch, MyobMode } from '../../shared/types.js';

const COOKIE = 'ip_ws';

type Env = { Variables: { ws: Workspace; ip: string } };

export const app = new Hono<Env>().basePath('/api');

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message, data: err.data }, err.status as 400);
  if (err instanceof ExtractionError) return c.json({ error: err.message }, err.retryable ? 503 : 422);
  console.error(err);
  return c.json({ error: 'Something went wrong on our side. Please try again.' }, 500);
});

app.use('*', async (c, next) => {
  c.set('ip', (c.req.header('x-forwarded-for') ?? c.req.header('x-client-ip') ?? 'local').split(',')[0].trim().replace(/:\d+$/, ''));
  await next();
  c.header('cache-control', 'no-store');
});

app.get('/health', async (c) => {
  const t0 = Date.now();
  await db()`select 1`;
  return c.json({ ok: true, db_ms: Date.now() - t0, version: process.env.GIT_SHA ?? 'dev' });
});

// Scheduled worker: retries due MYOB posts and prunes old demo workspaces.
app.post('/cron/sync', async (c) => {
  const given = Buffer.from(c.req.header('x-cron-secret') ?? '');
  const expected = Buffer.from(env.cronSecret);
  if (!expected.length || given.length !== expected.length || !timingSafeEqual(given, expected)) return c.json({ error: 'Forbidden' }, 403);
  const sync = await runDueJobs({ limit: 25 });
  const pruned = await pruneWorkspaces();
  return c.json({ sync, pruned });
});

// Everything below runs inside the visitor's workspace.
const ws = new Hono<Env>();

ws.use('*', async (c, next) => {
  let workspace = await findWorkspace(getCookie(c, COOKIE));
  if (!workspace) {
    workspace = await createWorkspace(c.get('ip'));
    setCookie(c, COOKIE, workspace.id, { httpOnly: true, sameSite: 'Lax', secure: env.isProduction, path: '/', maxAge: 60 * 60 * 24 * 30 });
  }
  c.set('ws', workspace);
  await next();
});

const session = (w: Workspace) => ({
  workspace_id: w.id,
  company_file_id: w.company_file_id,
  myob_mode: w.myob_mode,
  idempotency_guard: w.idempotency_guard,
});

ws.get('/session', (c) => c.json(session(c.get('ws'))));

ws.put('/settings', async (c) => {
  const body = (await c.req.json()) as { myob_mode?: MyobMode; idempotency_guard?: boolean };
  return c.json(session(await updateSettings(c.get('ws').id, body)));
});

ws.post('/reset', async (c) => {
  await deleteWorkspace(c.get('ws').id);
  deleteCookie(c, COOKIE, { path: '/' });
  const fresh = await createWorkspace(c.get('ip'));
  setCookie(c, COOKIE, fresh.id, { httpOnly: true, sameSite: 'Lax', secure: env.isProduction, path: '/', maxAge: 60 * 60 * 24 * 30 });
  return c.json(session(fresh));
});

ws.get('/accounts', async (c) => c.json(await listAccounts()));
ws.get('/stats', async (c) => c.json(await getStats(c.get('ws').id)));
ws.get('/invoices', async (c) => c.json(await listInvoices(c.get('ws').id)));

ws.post('/invoices', async (c) => {
  const form = await c.req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) throw new HttpError(400, 'Attach a file.');
  const result = await createInvoice(c.get('ws').id, c.get('ip'), { name: file.name, type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) });
  return c.json(result, 201);
});

ws.get('/invoices/:id', async (c) => c.json(await getInvoice(c.get('ws').id, c.req.param('id'))));

ws.get('/invoices/:id/file', async (c) => {
  const f = await getFile(c.get('ws').id, c.req.param('id'));
  return c.body(new Uint8Array(f.bytes), 200, {
    'content-type': f.file_mime,
    'content-disposition': `inline; filename="${f.file_name.replace(/"/g, '')}"`,
    'cache-control': 'private, max-age=3600',
  });
});

ws.post('/invoices/:id/extract', async (c) => c.json(await extractInvoice(c.get('ws').id, c.req.param('id'))));
ws.post('/invoices/:id/code', async (c) => c.json(await codeInvoice(c.get('ws').id, c.req.param('id'))));
ws.patch('/invoices/:id', async (c) => c.json(await patchInvoice(c.get('ws').id, c.req.param('id'), (await c.req.json()) as InvoicePatch)));
ws.post('/invoices/:id/approve', async (c) => c.json(await approveInvoice(c.get('ws').id, c.req.param('id'))));
ws.post('/invoices/:id/reject', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
  return c.json(await rejectInvoice(c.get('ws').id, c.req.param('id'), body.reason?.slice(0, 300) ?? ''));
});
ws.post('/invoices/:id/post', async (c) => c.json(await postInvoice(c.get('ws').id, c.req.param('id'))));

ws.get('/sync', async (c) => {
  const sql = db();
  const jobs = await sql`
    select j.id, j.invoice_id, j.state, j.attempts, j.uncertain, j.next_attempt_at, j.last_error, j.updated_at,
           i.supplier_name, i.invoice_number, i.total,
           coalesce((select json_agg(a order by a.at, a.id) from (
             select at, attempt, step, request, status, outcome, detail, duration_ms, id from sync_attempts where job_id = j.id
           ) a), '[]') as log
    from sync_jobs j join invoices i on i.id = j.invoice_id
    where j.workspace_id = ${c.get('ws').id}::uuid
    order by j.updated_at desc limit 50`;
  return c.json(jobs);
});

ws.post('/sync/run', async (c) => c.json(await runDueJobs({ workspaceId: c.get('ws').id, budgetMs: 8000 })));

ws.get('/reconcile', async (c) => c.json(await reconcile(c.get('ws').id)));

// A peek into the mock MYOB company file, fetched through the mock API itself.
ws.get('/myob/bills', async (c) => {
  const res = await myobMock.request(`/accountright/${c.get('ws').company_file_id}/Purchase/Bill/Service`, {
    headers: { authorization: 'Bearer demo', 'x-myobapi-key': 'demo' },
  });
  return c.json({ base: `${MOCK_BASE}/${c.get('ws').company_file_id}`, ...((await res.json()) as object) }, res.status as 200);
});

app.route('/', ws);
