// Compares what InvoicePilot believes it posted with what is actually in MYOB.
// Sync code can be careful and still drift: people edit or delete bills in MYOB, enter bills
// by hand, or an old script double-posts. Reconciliation is how you find out.
import { db } from './db.js';
import { differs, cents } from './lib/money.js';
import type { ReconcileKind, ReconcileReport, ReconcileRow } from '../../shared/types.js';

interface AppRow {
  invoice_id: string;
  supplier: string;
  invoice_number: string;
  total: number;
  bill_uid: string;
}

interface BillRow {
  uid: string;
  number: string;
  supplier_uid: string;
  supplier: string;
  supplier_invoice_number: string | null;
  total: number;
  source: 'api' | 'manual';
}

export function compare(app: AppRow[], bills: BillRow[]): ReconcileRow[] {
  const byUid = new Map(bills.map((b) => [b.uid, b]));
  const key = (b: BillRow) => `${b.supplier_uid}|${(b.supplier_invoice_number ?? '').toLowerCase()}`;
  const groups = new Map<string, BillRow[]>();
  for (const b of bills) {
    if (!b.supplier_invoice_number) continue;
    groups.set(key(b), [...(groups.get(key(b)) ?? []), b]);
  }

  const rows: ReconcileRow[] = [];
  const seen = new Set<string>();

  for (const inv of app) {
    const bill = byUid.get(inv.bill_uid);
    const base = { supplier: inv.supplier, supplier_invoice_number: inv.invoice_number, invoice_id: inv.invoice_id, app_total: inv.total };
    if (!bill) {
      rows.push({ ...base, kind: 'missing_in_myob', myob_total: null, myob_bill_uids: [inv.bill_uid], myob_bill_numbers: [], note: 'Posted from here, but the bill is no longer in MYOB. Someone may have deleted it.' });
      continue;
    }
    const group = bill.supplier_invoice_number ? (groups.get(key(bill)) ?? [bill]) : [bill];
    group.forEach((b) => seen.add(b.uid));
    if (group.length > 1) {
      rows.push({
        ...base,
        kind: 'duplicate_in_myob',
        myob_total: cents(group.reduce((s, b) => s + b.total, 0)),
        myob_bill_uids: group.map((b) => b.uid),
        myob_bill_numbers: group.map((b) => b.number),
        note: `${group.length} bills in MYOB for one supplier invoice. Void the extras before the payment run.`,
      });
    } else if (differs(bill.total, inv.total)) {
      const gap = cents(bill.total - inv.total);
      rows.push({
        ...base,
        kind: 'amount_mismatch',
        myob_total: bill.total,
        myob_bill_uids: [bill.uid],
        myob_bill_numbers: [bill.number],
        note: Math.abs(gap) <= 0.05 ? 'A few cents apart: MYOB rounds GST per line.' : `Out by $${Math.abs(gap).toFixed(2)}. The bill was changed in MYOB after it was posted.`,
      });
    } else {
      rows.push({ ...base, kind: 'matched', myob_total: bill.total, myob_bill_uids: [bill.uid], myob_bill_numbers: [bill.number], note: '' });
    }
  }

  for (const b of bills) {
    if (seen.has(b.uid)) continue;
    rows.push({
      kind: 'myob_only',
      supplier: b.supplier,
      supplier_invoice_number: b.supplier_invoice_number,
      invoice_id: null,
      app_total: null,
      myob_total: b.total,
      myob_bill_uids: [b.uid],
      myob_bill_numbers: [b.number],
      note: b.source === 'manual' ? 'Entered by hand in MYOB. Not an error, but it skipped review.' : 'Posted by another integration.',
    });
  }

  const order: ReconcileKind[] = ['duplicate_in_myob', 'missing_in_myob', 'amount_mismatch', 'myob_only', 'matched'];
  return rows.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}

export async function reconcile(workspaceId: string): Promise<ReconcileReport> {
  const sql = db();
  const app = await sql<AppRow[]>`
    select i.id as invoice_id, coalesce(s.name, i.supplier_name) as supplier, i.invoice_number, i.total, i.myob_bill_uid as bill_uid
    from invoices i left join suppliers s on s.id = i.supplier_id
    where i.workspace_id = ${workspaceId}::uuid and i.myob_bill_uid is not null`;
  const bills = await sql<BillRow[]>`
    select b.uid, b.number, b.supplier_uid, s.name as supplier, b.supplier_invoice_number, b.total, b.source
    from myob_bills b
    join myob_suppliers s on s.uid = b.supplier_uid
    join workspaces w on w.company_file_id = b.company_file_id
    where w.id = ${workspaceId}::uuid`;

  const rows = compare(app, bills);
  const totals = { matched: 0, amount_mismatch: 0, missing_in_myob: 0, duplicate_in_myob: 0, myob_only: 0 } as Record<ReconcileKind, number>;
  for (const r of rows) totals[r.kind] += 1;
  return { ran_at: new Date().toISOString(), rows, totals };
}
