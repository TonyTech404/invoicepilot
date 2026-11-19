import type { InvoiceStatus } from '../../../shared/types';
import { STATUS_LABEL } from '../lib/format';

const TONE: Record<InvoiceStatus, string> = {
  uploaded: 'bg-slate-wash text-slate',
  extracted: 'bg-slate-wash text-slate',
  needs_review: 'bg-amber-wash text-amber',
  approved: 'bg-bottle-wash text-bottle',
  posting: 'bg-slate-wash text-slate',
  posted: 'bg-bottle text-white',
  failed: 'bg-red-wash text-red-ink',
  rejected: 'bg-rule-soft text-ink-faint line-through',
};

export function StatusPill({ status }: { status: InvoiceStatus }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[13px] font-medium whitespace-nowrap ${TONE[status]}`}>
      {(status === 'posting' || status === 'uploaded' || status === 'extracted') && (
        <span className="mr-1.5 inline-block size-1.5 animate-pulse rounded-full bg-current" aria-hidden />
      )}
      {STATUS_LABEL[status]}
    </span>
  );
}
