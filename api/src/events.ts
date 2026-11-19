import type { Sql } from './db.js';

export async function addEvent(sql: Sql, invoiceId: string, kind: string, message: string, data?: Record<string, unknown>) {
  await sql`insert into events (invoice_id, kind, message, data) values (${invoiceId}::uuid, ${kind}, ${message}, ${data ? sql.json(data as never) : null})`;
}
