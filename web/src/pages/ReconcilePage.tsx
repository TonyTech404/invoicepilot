import { Link } from 'react-router';
import type { ReconcileKind, ReconcileReport } from '../../../shared/types';
import { useResource } from '../lib/api';
import { date, money } from '../lib/format';

const KIND: Record<ReconcileKind, { label: string; tone: string; explain: string }> = {
  duplicate_in_myob: { label: 'Duplicate in MYOB', tone: 'bg-red-wash text-red-ink', explain: 'The same supplier invoice is in MYOB more than once.' },
  missing_in_myob: { label: 'Missing from MYOB', tone: 'bg-red-wash text-red-ink', explain: 'Posted from here, but no longer in MYOB.' },
  amount_mismatch: { label: 'Amount differs', tone: 'bg-amber-wash text-amber', explain: 'MYOB has a different total than the approved invoice.' },
  myob_only: { label: 'Only in MYOB', tone: 'bg-slate-wash text-slate', explain: 'Not posted from here.' },
  matched: { label: 'Matches', tone: 'bg-bottle-wash text-bottle', explain: '' },
};

interface MyobBills {
  base: string;
  Items: Array<{ UID: string; Number: string; Date: string; SupplierInvoiceNumber: string | null; Supplier: { Name: string }; TotalAmount: number; Comment: string | null; Lines: unknown[] }>;
}

export function ReconcilePage() {
  const report = useResource<ReconcileReport>('/reconcile');
  const bills = useResource<MyobBills>('/myob/bills');
  const problems = report.data ? report.data.totals.duplicate_in_myob + report.data.totals.missing_in_myob + report.data.totals.amount_mismatch : 0;

  return (
    <div className="space-y-12">
      <div>
        <h1 className="text-[30px] leading-tight font-semibold tracking-[-0.02em]">Reconcile with MYOB</h1>
        <p className="mt-2 max-w-[70ch] text-[16px] text-ink-soft">
          Careful sync code still drifts from the books: people edit bills in MYOB, type some in by hand, and old scripts double-post. This compares
          every bill the app posted with what MYOB holds now.
        </p>
      </div>

      <section aria-labelledby="diff-h">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="diff-h" className="text-[20px] font-semibold tracking-[-0.01em]">
            {report.data ? (problems ? `${problems} ${problems === 1 ? 'problem' : 'problems'} to sort out` : 'Everything matches') : 'Comparing…'}
          </h2>
          <button className="btn btn-quiet" onClick={() => void report.reload()}>
            Compare again
          </button>
        </div>

        <div className="-mx-4 mt-4 overflow-x-auto px-4">
          <table className="ledger min-w-[760px]">
            <thead>
              <tr>
                <th>Result</th>
                <th>Supplier</th>
                <th>Invoice</th>
                <th className="text-right!">Approved here</th>
                <th className="text-right!">In MYOB</th>
                <th>What to do</th>
              </tr>
            </thead>
            <tbody>
              {(report.data?.rows ?? []).map((r, i) => (
                <tr key={i}>
                  <td>
                    <span className={`inline-block rounded-full px-2.5 py-0.5 text-[13px] font-medium whitespace-nowrap ${KIND[r.kind].tone}`}>{KIND[r.kind].label}</span>
                  </td>
                  <td className="font-medium">
                    {r.invoice_id ? (
                      <Link to={`/invoices/${r.invoice_id}`} className="hover:underline">
                        {r.supplier}
                      </Link>
                    ) : (
                      r.supplier
                    )}
                  </td>
                  <td className="num text-ink-soft">{r.supplier_invoice_number ?? '—'}</td>
                  <td className="num text-right">{money(r.app_total)}</td>
                  <td className={`num text-right ${r.kind !== 'matched' && r.kind !== 'myob_only' ? 'font-semibold text-red-ink' : ''}`}>
                    {money(r.myob_total)}
                    {r.myob_bill_numbers.length > 1 && <span className="block text-[12px] font-normal text-ink-faint">bills {r.myob_bill_numbers.join(', ')}</span>}
                  </td>
                  <td className="max-w-[40ch] text-[14px] text-ink-soft">{r.note || KIND[r.kind].explain}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="myob-h">
        <h2 id="myob-h" className="text-[20px] font-semibold tracking-[-0.01em]">
          Bills in the MYOB company file
        </h2>
        <p className="mt-1 max-w-[70ch] text-ink-soft">
          Read through the simulated AccountRight API: <span className="text-[14px] break-all text-ink-faint">GET {bills.data?.base}/Purchase/Bill/Service</span>
        </p>
        <div className="-mx-4 mt-4 overflow-x-auto px-4">
          <table className="ledger min-w-[760px]">
            <thead>
              <tr>
                <th>Bill</th>
                <th>Date</th>
                <th>Supplier</th>
                <th>Supplier invoice</th>
                <th className="text-right!">Total</th>
                <th>Comment</th>
              </tr>
            </thead>
            <tbody>
              {(bills.data?.Items ?? []).map((b) => (
                <tr key={b.UID}>
                  <td className="num">{b.Number}</td>
                  <td className="num whitespace-nowrap text-ink-soft">{date(b.Date.slice(0, 10))}</td>
                  <td>{b.Supplier.Name}</td>
                  <td className="num text-ink-soft">{b.SupplierInvoiceNumber ?? '—'}</td>
                  <td className="num text-right">{money(b.TotalAmount)}</td>
                  <td className="text-[14px] text-ink-faint">{b.Comment?.startsWith('InvoicePilot') ? 'Posted by InvoicePilot' : b.Comment}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
