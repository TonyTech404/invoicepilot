import { useEffect, useRef, useState, type DragEvent } from 'react';
import { useNavigate } from 'react-router';
import type { InvoiceSummary, Stats } from '../../../shared/types';
import { api, ApiError, useResource } from '../lib/api';
import { date, money } from '../lib/format';
import { StatusPill } from '../components/StatusPill';

interface Sample {
  id: string;
  label: string;
  note: string;
  supplier: string;
  file: string;
  mime: string;
  thumb: string;
  total: number;
}

function Totals({ stats }: { stats: Stats }) {
  const items = [
    { label: 'Waiting for review', value: String(stats.counts.needs_review), tone: stats.counts.needs_review ? 'text-amber' : '' },
    { label: 'Approved, not yet posted', value: money(stats.approved_value) },
    { label: 'Posted to MYOB', value: money(stats.posted_value) },
    { label: 'Failed to post', value: String(stats.counts.failed), tone: stats.counts.failed ? 'text-red-ink' : '' },
    { label: 'AI account suggestions kept', value: stats.ai_accept_rate == null ? '—' : `${Math.round(stats.ai_accept_rate * 100)}%` },
  ];
  return (
    <dl className="grid grid-cols-2 border-y-[1.5px] border-ink sm:grid-cols-3 lg:grid-cols-5">
      {items.map((i) => (
        <div key={i.label} className="border-b border-rule px-1 py-3 sm:px-3 lg:border-b-0 lg:border-l lg:first:border-l-0">
          <dt className="text-[13px] text-ink-soft">{i.label}</dt>
          <dd className={`num mt-0.5 text-[22px] font-semibold tracking-[-0.01em] ${i.tone ?? ''}`}>{i.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Upload({ onUploaded }: { onUploaded: (id: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [list, setList] = useState<Sample[] | null>(null);

  useEffect(() => {
    fetch('/samples/samples.json')
      .then((r) => r.json())
      .then(setList)
      .catch(() => setList([]));
  }, []);

  async function send(file: File, label: string) {
    setBusy(label);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const { id } = await api<{ id: string }>('/invoices', { method: 'POST', body: form });
      onUploaded(id);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The upload failed. Check your connection and try again.');
      setBusy(null);
    }
  }

  async function sendSample(s: Sample) {
    const blob = await (await fetch(`/samples/${s.file}`)).blob();
    await send(new File([blob], s.file, { type: s.mime }), s.id);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setOver(false);
    const file = e.dataTransfer.files[0];
    if (file) void send(file, 'drop');
  }

  return (
    <section className="grid gap-6 lg:grid-cols-[minmax(280px,1fr)_2.2fr]" aria-labelledby="add-heading">
      <div>
        <h2 id="add-heading" className="text-[17px] font-semibold">
          Add an invoice
        </h2>
        <p className="mt-1 text-ink-soft">Drop a supplier invoice here. A PDF or a phone photo works.</p>
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
          className={`mt-4 flex min-h-44 flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 text-center transition-colors ${
            over ? 'border-bottle bg-bottle-wash' : 'border-rule bg-sheet/60'
          }`}
        >
          <p className="text-ink-soft">{busy === 'drop' ? 'Uploading…' : 'Drag a file here, or'}</p>
          <button className="btn btn-primary mt-3" disabled={!!busy} onClick={() => input.current?.click()}>
            Choose a file
          </button>
          <p className="mt-3 text-[13px] text-ink-faint">PDF, JPEG or PNG, up to 4 MB</p>
          <input
            ref={input}
            type="file"
            accept="application/pdf,image/jpeg,image/png"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void send(f, 'drop');
              e.target.value = '';
            }}
          />
        </div>
        {error && (
          <p className="mt-3 rounded-md bg-red-wash px-3 py-2 text-[14px] text-red-ink" role="alert">
            {error}
          </p>
        )}
      </div>

      <div>
        <h2 className="text-[17px] font-semibold">Or try a sample</h2>
        <p className="mt-1 text-ink-soft">Six made-up supplier invoices, each with something a bookkeeper would need to catch.</p>
        <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {(list ?? []).map((s) => (
            <li key={s.id}>
              <button
                onClick={() => void sendSample(s)}
                disabled={!!busy}
                className="group flex h-full w-full gap-3 rounded-lg border border-rule bg-sheet p-2.5 text-left transition-colors hover:border-bottle disabled:opacity-60"
              >
                <img src={`/samples/${s.thumb}`} alt="" className="h-[88px] w-[62px] shrink-0 rounded-[3px] border border-rule-soft object-cover object-top" loading="lazy" />
                <span className="min-w-0">
                  <span className="block text-[14px] leading-snug font-medium">{busy === s.id ? 'Uploading…' : s.label}</span>
                  <span className="mt-0.5 block truncate text-[13px] text-ink-faint">{s.supplier}</span>
                  <span className="mt-1 block text-[13px] leading-snug text-ink-soft">{s.note}</span>
                </span>
              </button>
            </li>
          ))}
          {!list && Array.from({ length: 6 }, (_, i) => <li key={i} className="h-[110px] animate-pulse rounded-lg bg-rule-soft" />)}
        </ul>
      </div>
    </section>
  );
}

function InvoiceTable({ invoices, onOpen }: { invoices: InvoiceSummary[]; onOpen: (id: string) => void }) {
  if (!invoices.length) {
    return <p className="py-10 text-center text-ink-soft">No invoices yet. Add one above to see it read, coded and checked.</p>;
  }
  return (
    <div className="-mx-4 overflow-x-auto px-4">
      <table className="ledger min-w-[760px]">
        <thead>
          <tr>
            <th>Supplier</th>
            <th>Invoice</th>
            <th>Date</th>
            <th>Due</th>
            <th className="text-right!">Total</th>
            <th>Status</th>
            <th>Checks</th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((i) => (
            <tr key={i.id} className="link" onClick={() => onOpen(i.id)}>
              <td className="font-medium">
                <a
                  href={`/invoices/${i.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    onOpen(i.id);
                  }}
                  className="hover:underline"
                >
                  {i.supplier_name ?? i.file_name}
                </a>
              </td>
              <td className="num text-ink-soft">{i.invoice_number ?? '—'}</td>
              <td className="num whitespace-nowrap text-ink-soft">{date(i.invoice_date)}</td>
              <td className="num whitespace-nowrap text-ink-soft">{date(i.due_date)}</td>
              <td className="num text-right font-medium">{money(i.total)}</td>
              <td>
                <StatusPill status={i.status} />
              </td>
              <td className="text-[14px] whitespace-nowrap">
                {i.errors > 0 && <span className="text-red-ink">{i.errors} to fix</span>}
                {i.errors > 0 && i.warnings > 0 && <span className="text-ink-faint">, </span>}
                {i.warnings > 0 && <span className="text-amber">{i.warnings} to check</span>}
                {!i.errors && !i.warnings && ['needs_review', 'approved', 'posted', 'posting'].includes(i.status) && <span className="text-ink-faint">All clear</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function InboxPage() {
  const navigate = useNavigate();
  const invoices = useResource<InvoiceSummary[]>('/invoices', { pollMs: 15000 });
  const stats = useResource<Stats>('/stats', { pollMs: 15000 });

  return (
    <div className="space-y-12">
      <div>
        <h1 className="text-[30px] leading-tight font-semibold tracking-[-0.02em]">Supplier invoices</h1>
        <p className="mt-2 max-w-[68ch] text-[16px] text-ink-soft">
          Azure reads each invoice, AI suggests the accounts, you check and approve, and approved bills post to MYOB.
        </p>
        <div className="mt-6">{stats.data ? <Totals stats={stats.data} /> : <div className="h-[78px] animate-pulse border-y-[1.5px] border-ink/20" />}</div>
      </div>

      <Upload onUploaded={(id) => navigate(`/invoices/${id}`)} />

      <section aria-labelledby="list-heading">
        <h2 id="list-heading" className="mb-3 text-[17px] font-semibold">
          All invoices
        </h2>
        {invoices.error && <p className="text-red-ink">{invoices.error}</p>}
        {invoices.data ? <InvoiceTable invoices={invoices.data} onOpen={(id) => navigate(`/invoices/${id}`)} /> : <div className="h-64 animate-pulse rounded bg-rule-soft" />}
      </section>
    </div>
  );
}
