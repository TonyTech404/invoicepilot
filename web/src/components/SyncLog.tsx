import type { SyncAttempt } from '../../../shared/types';
import { dateTime } from '../lib/format';

const OUTCOME: Record<SyncAttempt['outcome'], { label: string; tone: string }> = {
  ok: { label: 'Done', tone: 'text-bottle' },
  found: { label: 'Already there', tone: 'text-bottle' },
  retry: { label: 'Retry', tone: 'text-amber' },
  uncertain: { label: 'No response', tone: 'text-red-ink' },
  fatal: { label: 'Rejected', tone: 'text-red-ink' },
};

const STEP: Record<SyncAttempt['step'], string> = {
  lookup: 'Look for existing bill',
  supplier: 'Supplier card',
  post: 'Create bill',
};

export function SyncLog({ log }: { log: SyncAttempt[] }) {
  if (!log.length) return <p className="text-[14px] text-ink-faint">No calls to MYOB yet.</p>;
  return (
    <ol className="divide-y divide-rule border-y border-rule">
      {log.map((a, i) => (
        <li key={i} className="grid grid-cols-[2.25rem_1fr_auto] gap-x-3 py-2.5 text-[14px]">
          <span className="num pt-px text-ink-faint" title="Attempt">
            #{a.attempt}
          </span>
          <div className="min-w-0">
            <p>
              <span className="font-medium">{STEP[a.step]}</span>
              <span className={`ml-2 font-medium ${OUTCOME[a.outcome].tone}`}>{OUTCOME[a.outcome].label}</span>
            </p>
            <p className="mt-0.5 truncate text-[13px] text-ink-faint" title={a.request}>
              {a.request}
            </p>
            {a.detail && <p className="mt-0.5 text-[13px] text-ink-soft">{a.detail}</p>}
          </div>
          <div className="num text-right text-[13px] text-ink-faint">
            <div>{a.status ?? 'timeout'}</div>
            <div>{a.duration_ms} ms</div>
            <div className="hidden sm:block">{dateTime(a.at)}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}
