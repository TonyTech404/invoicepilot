import { useState } from 'react';
import { Link } from 'react-router';
import type { MyobMode, SyncAttempt, SyncJob } from '../../../shared/types';
import { api, useResource } from '../lib/api';
import { ago, money } from '../lib/format';
import { useSession } from '../session';
import { SyncLog } from '../components/SyncLog';

interface JobRow extends Omit<SyncJob, 'log'> {
  id: string;
  invoice_id: string;
  supplier_name: string;
  invoice_number: string;
  total: number;
  updated_at: string;
  log: SyncAttempt[];
}

const MODES: Array<{ mode: MyobMode; title: string; body: string }> = [
  { mode: 'healthy', title: 'Healthy', body: 'Every call works, in about a quarter of a second.' },
  {
    mode: 'flaky',
    title: 'Flaky',
    body: 'Nearly half of calls fail with a rate limit (MYOB answers 403 “Developer Over Qps”) or a 503. Posts retry with backoff.',
  },
  {
    mode: 'lost_responses',
    title: 'Dropping responses',
    body: 'MYOB saves the bill, then the connection drops before the reply arrives. The app cannot tell whether the bill exists.',
  },
];

const STATE: Record<SyncJob['state'], { label: string; tone: string }> = {
  pending: { label: 'Waiting', tone: 'text-slate' },
  retrying: { label: 'Retrying', tone: 'text-amber' },
  succeeded: { label: 'Posted', tone: 'text-bottle' },
  failed: { label: 'Failed', tone: 'text-red-ink' },
};

function FailureLab() {
  const { session, update } = useSession();
  if (!session) return null;
  return (
    <section id="failure-lab" aria-labelledby="lab-h" className="scroll-mt-24">
      <h2 id="lab-h" className="text-[20px] font-semibold tracking-[-0.01em]">
        Failure lab
      </h2>
      <p className="mt-1 max-w-[70ch] text-ink-soft">
        MYOB here is a simulation, so you can make it misbehave. Pick a mode, then approve and post an invoice to watch how the sync copes.
      </p>

      <fieldset className="mt-5 grid gap-3 md:grid-cols-3">
        <legend className="sr-only">How the simulated MYOB behaves</legend>
        {MODES.map((m) => {
          const on = session.myob_mode === m.mode;
          return (
            <label
              key={m.mode}
              className={`cursor-pointer rounded-lg border p-4 transition-colors ${on ? 'border-bottle bg-bottle-wash' : 'border-rule bg-sheet hover:border-ink-faint'}`}
            >
              <input type="radio" name="mode" className="sr-only" checked={on} onChange={() => void update({ myob_mode: m.mode })} />
              <span className="flex items-center gap-2 font-medium">
                <span className={`size-3.5 rounded-full border-2 ${on ? 'border-bottle bg-bottle shadow-[inset_0_0_0_2px_var(--color-bottle-wash)]' : 'border-ink-faint'}`} aria-hidden />
                {m.title}
              </span>
              <span className="mt-1.5 block text-[14px] leading-snug text-ink-soft">{m.body}</span>
            </label>
          );
        })}
      </fieldset>

      <div className={`mt-4 flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-start ${session.idempotency_guard ? 'border-rule bg-sheet' : 'border-red-ink bg-red-wash'}`}>
        <button
          role="switch"
          aria-checked={session.idempotency_guard}
          onClick={() => void update({ idempotency_guard: !session.idempotency_guard })}
          className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors ${session.idempotency_guard ? 'bg-bottle' : 'bg-red-ink'}`}
        >
          <span className="sr-only">Duplicate guard</span>
          <span className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-[left] ${session.idempotency_guard ? 'left-[22px]' : 'left-0.5'}`} />
        </button>
        <div className="text-[14px] leading-snug">
          <p className="font-medium">Duplicate guard is {session.idempotency_guard ? 'on' : 'off'}</p>
          <p className="mt-1 max-w-[75ch] text-ink-soft">
            MYOB has no idempotency keys, so a retry after a dropped response can post the same bill twice. With the guard on, the app first searches
            MYOB for the supplier invoice number and links the bill it finds. Turn it off with “Dropping responses” to see the duplicate, then find it on
            the <Link to="/reconcile" className="underline">Reconcile</Link> page.
          </p>
        </div>
      </div>
    </section>
  );
}

export function SyncPage() {
  const jobs = useResource<JobRow[]>('/sync', { pollMs: 10000 });
  const [open, setOpen] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [ran, setRan] = useState<string | null>(null);

  async function runNow() {
    setRunning(true);
    const r = await api<{ ran: number; succeeded: number; retrying: number; failed: number }>('/sync/run', { method: 'POST' });
    setRan(r.ran ? `Ran ${r.ran}: ${r.succeeded} posted, ${r.retrying} still retrying, ${r.failed} failed.` : 'Nothing is due right now.');
    setRunning(false);
    void jobs.reload();
  }

  return (
    <div className="space-y-12">
      <div>
        <h1 className="text-[30px] leading-tight font-semibold tracking-[-0.02em]">MYOB sync</h1>
        <p className="mt-2 max-w-[70ch] text-[16px] text-ink-soft">
          Approved invoices go into an outbox and post to MYOB as bills. Failed calls retry with backoff, and a scheduled job picks up anything left
          over every 15 minutes.
        </p>
      </div>

      <FailureLab />

      <section aria-labelledby="jobs-h">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="jobs-h" className="text-[20px] font-semibold tracking-[-0.01em]">
            Posts
          </h2>
          <div className="flex items-center gap-3">
            {ran && <span className="text-[14px] text-ink-soft">{ran}</span>}
            <button className="btn btn-quiet" disabled={running} onClick={() => void runNow()}>
              {running ? 'Running…' : 'Run due retries now'}
            </button>
          </div>
        </div>
        <ul className="mt-4 border-t-[1.5px] border-ink">
          {(jobs.data ?? []).map((j) => (
            <li key={j.id} className="border-b border-rule">
              <button className="grid w-full grid-cols-[1fr_auto] items-baseline gap-x-4 gap-y-1 py-3 text-left sm:grid-cols-[1fr_8rem_7rem_9rem]" onClick={() => setOpen(open === j.id ? null : j.id)} aria-expanded={open === j.id}>
                <span>
                  <span className="font-medium">{j.supplier_name}</span>
                  <span className="num ml-2 text-ink-soft">{j.invoice_number}</span>
                </span>
                <span className="num text-right">{money(j.total)}</span>
                <span className={`font-medium ${STATE[j.state].tone}`}>
                  {STATE[j.state].label}
                  <span className="num ml-1.5 font-normal text-ink-faint">{j.attempts > 1 ? `${j.attempts} tries` : ''}</span>
                </span>
                <span className="text-right text-[14px] text-ink-faint">{ago(j.updated_at)}</span>
              </button>
              {open === j.id && (
                <div className="pb-4 pl-0 sm:pl-4">
                  <SyncLog log={j.log} />
                  <Link to={`/invoices/${j.invoice_id}`} className="mt-2 inline-block text-[14px] underline">
                    Open the invoice
                  </Link>
                </div>
              )}
            </li>
          ))}
        </ul>
        {jobs.data && !jobs.data.length && <p className="py-8 text-center text-ink-soft">Nothing posted yet.</p>}
      </section>
    </div>
  );
}
