// Each visitor gets their own workspace (and mock MYOB company file), identified by a cookie.
import { db } from './db.js';
import { seedWorkspace } from './seed/seed.js';
import { refreshChecks, HttpError } from './invoices.js';
import { allow } from './ratelimit.js';
import type { MyobMode } from '../../shared/types.js';

export interface Workspace {
  id: string;
  company_file_id: string;
  myob_mode: MyobMode;
  idempotency_guard: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function findWorkspace(id: string | undefined): Promise<Workspace | null> {
  if (!id || !UUID.test(id)) return null;
  const [ws] = await db()<Workspace[]>`
    update workspaces set last_seen_at = now() where id = ${id}::uuid
    returning id, company_file_id, myob_mode, idempotency_guard`;
  return ws ?? null;
}

export async function createWorkspace(ip: string): Promise<Workspace> {
  if (!(await allow(`workspace:${ip}`, 3600, 30))) throw new HttpError(429, 'Too many new sessions from this address. Try again later.');
  const sql = db();
  const ws = await sql.begin(async (tx) => {
    const [row] = await tx<Workspace[]>`insert into workspaces default values returning id, company_file_id, myob_mode, idempotency_guard`;
    await seedWorkspace(tx, row.id, row.company_file_id);
    return row;
  });
  const ids = await sql<{ id: string }[]>`select id from invoices where workspace_id = ${ws.id}::uuid`;
  await Promise.all(ids.map(({ id }) => refreshChecks(sql, ws.id, id)));
  return ws;
}

export async function updateSettings(id: string, patch: { myob_mode?: MyobMode; idempotency_guard?: boolean }): Promise<Workspace> {
  const modes: MyobMode[] = ['healthy', 'flaky', 'lost_responses'];
  if (patch.myob_mode && !modes.includes(patch.myob_mode)) throw new HttpError(400, 'Unknown MYOB mode');
  const [ws] = await db()<Workspace[]>`
    update workspaces set
      myob_mode = coalesce(${patch.myob_mode ?? null}, myob_mode),
      idempotency_guard = coalesce(${patch.idempotency_guard ?? null}::boolean, idempotency_guard)
    where id = ${id}::uuid
    returning id, company_file_id, myob_mode, idempotency_guard`;
  return ws;
}

export async function deleteWorkspace(id: string) {
  await db()`delete from workspaces where id = ${id}::uuid`;
}

/** Demo housekeeping: drop workspaces nobody has opened for two weeks. */
export async function pruneWorkspaces(): Promise<number> {
  const rows = await db()`delete from workspaces where last_seen_at < now() - interval '14 days' returning id`;
  await db()`delete from rate_limits where window_start < now() - interval '2 days'`;
  return rows.length;
}
