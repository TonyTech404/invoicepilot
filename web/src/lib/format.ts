import type { InvoiceStatus } from '../../../shared/types';

const aud = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' });

export const money = (n: number | null | undefined) => (n == null ? '—' : aud.format(n));
export const plain = (n: number | null | undefined) =>
  n == null ? '' : n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function date(iso: string | null | undefined) {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function dateTime(iso: string) {
  return new Date(iso).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

export function ago(iso: string) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return date(iso);
}

export const seconds = (ms: number | null | undefined) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)}s`);

export const STATUS_LABEL: Record<InvoiceStatus, string> = {
  uploaded: 'Reading',
  extracted: 'Coding',
  needs_review: 'Needs review',
  approved: 'Approved',
  posting: 'Posting',
  posted: 'Posted to MYOB',
  failed: 'Post failed',
  rejected: 'Rejected',
};

export const formatAbn = (abn: string | null) =>
  abn && abn.length === 11 ? `${abn.slice(0, 2)} ${abn.slice(2, 5)} ${abn.slice(5, 8)} ${abn.slice(8)}` : (abn ?? '');
