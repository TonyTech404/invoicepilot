import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import type { Account, Check, HeaderField, Invoice, InvoiceLine, InvoicePatch, TaxCode } from '../../../shared/types';
import { api, ApiError, useResource } from '../lib/api';
import { date, dateTime, formatAbn, money, plain, seconds } from '../lib/format';
import { DocumentViewer, type Region } from '../components/DocumentViewer';
import { StatusPill } from '../components/StatusPill';
import { SyncLog } from '../components/SyncLog';

const EDITABLE = ['extracted', 'needs_review', 'failed'];

// ── Processing: the steps run in the browser's sight ────────────────────────

const inFlight = new Set<string>();

type StepState = 'done' | 'active' | 'todo' | 'error';

function Processing({ invoice, onDone }: { invoice: Invoice; onDone: (inv: Invoice) => void }) {
  const [phase, setPhase] = useState<'extract' | 'code' | 'checks'>(invoice.status === 'uploaded' ? 'extract' : 'code');
  const [error, setError] = useState<string | null>(null);
  const [took, setTook] = useState<{ extract?: number; code?: number }>({});
  const [tick, setTick] = useState(0);
  const startedAt = useRef(Date.now());

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 100);
    return () => clearInterval(t);
  }, []);

  async function run(from: 'extract' | 'code') {
    if (inFlight.has(invoice.id)) return;
    inFlight.add(invoice.id);
    setError(null);
    try {
      let current = invoice;
      if (from === 'extract') {
        setPhase('extract');
        startedAt.current = Date.now();
        current = await api<Invoice>(`/invoices/${invoice.id}/extract`, { method: 'POST' });
        // No timing means Azure's earlier result for this exact file was reused.
        setTook((t) => ({ ...t, extract: current.extract_ms ?? -1 }));
      }
      setPhase('code');
      startedAt.current = Date.now();
      current = await api<Invoice>(`/invoices/${invoice.id}/code`, { method: 'POST' });
      setTook((t) => ({ ...t, code: current.code_ms ?? Date.now() - startedAt.current }));
      setPhase('checks');
      await new Promise((r) => setTimeout(r, 450));
      onDone(current);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Lost the connection. Try again.');
    } finally {
      inFlight.delete(invoice.id);
    }
  }

  useEffect(() => {
    void run(invoice.status === 'uploaded' ? 'extract' : 'code');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoice.id]);

  const elapsed = ((Date.now() - startedAt.current) / 1000).toFixed(1);
  void tick;
  const state = (step: 'extract' | 'code' | 'checks'): StepState => {
    const order = ['extract', 'code', 'checks'];
    if (error && step === phase) return 'error';
    if (order.indexOf(step) < order.indexOf(phase)) return 'done';
    return step === phase ? 'active' : 'todo';
  };

  const steps = [
    { key: 'upload', title: 'Uploaded', detail: invoice.file_name, state: 'done' as StepState },
    {
      key: 'extract',
      title: 'Read with Azure AI Document Intelligence',
      detail:
        took.extract === -1
          ? 'Reused Azure’s earlier result for this exact file, to save free-tier pages'
          : took.extract != null
            ? `Prebuilt invoice model, ${seconds(took.extract)}`
            : state('extract') === 'active' ? `Finding supplier, dates, totals and line items… ${elapsed}s` : 'Prebuilt invoice model',
      state: invoice.status === 'extracted' && !took.extract ? ('done' as StepState) : state('extract'),
    },
    {
      key: 'code',
      title: 'Suggest accounts with Azure OpenAI',
      detail: took.code != null ? `Coded every line in ${seconds(took.code)}` : state('code') === 'active' ? `Matching lines to the chart of accounts and GST codes… ${elapsed}s` : 'Uses this supplier’s past codings',
      state: state('code'),
    },
    { key: 'checks', title: 'Check the numbers', detail: 'Totals, GST, ABN, duplicates', state: state('checks') },
  ];

  return (
    <div className="max-w-xl">
      <h1 className="text-[26px] font-semibold tracking-[-0.02em]">Reading the invoice</h1>
      <ol className="mt-6 border-l-2 border-rule">
        {steps.map((s) => (
          <li key={s.key} className="relative pb-6 pl-6 last:pb-0">
            <span
              className={`absolute top-1 -left-[7px] size-3 rounded-full border-2 ${
                s.state === 'done'
                  ? 'border-bottle bg-bottle'
                  : s.state === 'active'
                    ? 'animate-pulse border-bottle bg-paper'
                    : s.state === 'error'
                      ? 'border-red-ink bg-red-ink'
                      : 'border-rule bg-paper'
              }`}
              aria-hidden
            />
            <p className={`font-medium ${s.state === 'todo' ? 'text-ink-faint' : ''}`}>{s.title}</p>
            <p className="num text-[14px] text-ink-soft">{s.detail}</p>
          </li>
        ))}
      </ol>
      {error && (
        <div className="mt-6 rounded-md bg-red-wash p-4 text-red-ink" role="alert">
          <p>{error}</p>
          <button className="btn btn-quiet mt-3 bg-sheet" onClick={() => void run(phase === 'extract' ? 'extract' : 'code')}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

// ── Review ──────────────────────────────────────────────────────────────────

const FIELDS: Array<{ key: HeaderField; label: string; type: 'text' | 'date' | 'money'; wide?: boolean }> = [
  { key: 'supplier_name', label: 'Supplier', type: 'text', wide: true },
  { key: 'supplier_abn', label: 'ABN', type: 'text' },
  { key: 'invoice_number', label: 'Invoice number', type: 'text' },
  { key: 'invoice_date', label: 'Invoice date', type: 'date' },
  { key: 'due_date', label: 'Due date', type: 'date' },
  { key: 'po_number', label: 'Our PO', type: 'text' },
];

const TOTAL_FIELDS: Array<{ key: HeaderField; label: string }> = [
  { key: 'subtotal', label: 'Subtotal' },
  { key: 'tax', label: 'GST' },
  { key: 'total', label: 'Total' },
];

function fieldValue(inv: Invoice, key: HeaderField): string {
  const v = inv[key as keyof Invoice] as string | number | null;
  if (v == null) return '';
  if (key === 'supplier_abn') return formatAbn(v as string);
  if (typeof v === 'number') return plain(v);
  return String(v);
}

function Confidence({ value }: { value: number | undefined }) {
  if (value == null) return null;
  const pct = Math.round(value * 100);
  const low = value < 0.8;
  return (
    <span className={`num text-[12px] ${low ? 'font-medium text-amber' : 'text-ink-faint'}`} title="How sure Document Intelligence was when it read this">
      {low ? `Read at ${pct}%, check it` : `${pct}%`}
    </span>
  );
}

function Field({
  inv,
  def,
  editable,
  flagged,
  onFocus,
  onSave,
}: {
  inv: Invoice;
  def: { key: HeaderField; label: string; type: 'text' | 'date' | 'money' };
  editable: boolean;
  flagged: Check['level'] | null;
  onFocus: () => void;
  onSave: (value: string) => void;
}) {
  const initial = fieldValue(inv, def.key);
  const [draft, setDraft] = useState(initial);
  useEffect(() => setDraft(initial), [initial]);
  const id = `f-${def.key}`;
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-[13px] text-ink-soft">
          {def.label}
        </label>
        <Confidence value={inv.confidence[def.key]} />
      </div>
      <input
        id={id}
        className={`field ${def.type !== 'text' ? 'num' : ''} ${def.type === 'money' ? 'text-right' : ''} ${
          flagged === 'error' ? 'border-red-ink!' : flagged === 'warning' ? 'border-amber!' : ''
        }`}
        type={def.type === 'date' ? 'date' : 'text'}
        inputMode={def.type === 'money' ? 'decimal' : undefined}
        value={draft}
        disabled={!editable}
        onFocus={onFocus}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== initial && onSave(draft)}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
    </div>
  );
}

const KIND_LABEL: Record<Account['kind'], string> = { cost_of_sales: 'Cost of sales', expense: 'Expenses', asset: 'Assets' };

function AccountSelect({ value, accounts, disabled, onChange, onFocus, id }: { value: string | null; accounts: Account[]; disabled: boolean; onChange: (v: string) => void; onFocus: () => void; id: string }) {
  const groups = (['cost_of_sales', 'expense', 'asset'] as const).map((k) => ({ k, items: accounts.filter((a) => a.kind === k) }));
  return (
    <select id={id} className="field pr-7 disabled:appearance-none" value={value ?? ''} disabled={disabled} onFocus={onFocus} onChange={(e) => onChange(e.target.value)}>
      {!value && <option value="">Choose an account</option>}
      {groups.map((g) => (
        <optgroup key={g.k} label={KIND_LABEL[g.k]}>
          {g.items.map((a) => (
            <option key={a.code} value={a.code} disabled={!a.active}>
              {a.code} {a.name}
              {a.active ? '' : ' (closed)'}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function LineRow({
  line,
  accounts,
  editable,
  active,
  flagged,
  onFocus,
  onPatch,
}: {
  line: InvoiceLine;
  accounts: Account[];
  editable: boolean;
  active: boolean;
  flagged: Check['level'] | null;
  onFocus: () => void;
  onPatch: (p: Omit<NonNullable<InvoicePatch['lines']>[number], 'id'>) => void;
}) {
  const [amount, setAmount] = useState(plain(line.amount));
  useEffect(() => setAmount(plain(line.amount)), [line.amount]);
  const ai = accounts.find((a) => a.code === line.ai_account_code);
  const changed = line.ai_account_code && line.account_code !== line.ai_account_code;
  const conf = line.ai_confidence;

  return (
    <li
      id={`line-${line.position}`}
      className={`grid grid-cols-[1.75rem_1fr] gap-x-2 border-b border-rule py-3.5 transition-colors ${active ? 'bg-highlight/15' : ''} ${
        flagged === 'error' ? 'shadow-[inset_3px_0_0_var(--color-red-ink)]' : flagged === 'warning' ? 'shadow-[inset_3px_0_0_var(--color-amber)]' : ''
      }`}
      onFocusCapture={onFocus}
      onMouseEnter={onFocus}
    >
      <span className="num pt-2 pl-2 text-[13px] text-ink-faint">{line.position}</span>
      <div className="min-w-0 pr-2">
        <div className="flex items-start gap-3">
          <p className="min-w-0 flex-1 pt-2 leading-snug">
            {line.description || <span className="text-ink-faint">No description</span>}
            {line.quantity != null && line.unit_price != null && (
              <span className="num block text-[13px] text-ink-faint">
                {line.quantity} × {plain(line.unit_price)}
              </span>
            )}
          </p>
          <input
            aria-label={`Line ${line.position} amount`}
            className="field num w-28 shrink-0 text-right"
            value={amount}
            disabled={!editable}
            inputMode="decimal"
            onChange={(e) => setAmount(e.target.value)}
            onBlur={() => amount !== plain(line.amount) && onPatch({ amount: Number(amount.replace(/[^0-9.-]/g, '')) })}
          />
        </div>
        <div className="mt-2 grid grid-cols-[1fr_6.5rem] gap-2">
          <AccountSelect
            id={`line-${line.position}-account`}
            value={line.account_code}
            accounts={accounts}
            disabled={!editable}
            onFocus={onFocus}
            onChange={(v) => onPatch({ account_code: v })}
          />
          <select
            aria-label={`Line ${line.position} GST code`}
            className="field disabled:appearance-none"
            value={line.tax_code ?? ''}
            disabled={!editable}
            onChange={(e) => onPatch({ tax_code: e.target.value as TaxCode })}
          >
            <option value="GST">GST 10%</option>
            <option value="FRE">GST-free</option>
            <option value="N-T">Not reportable</option>
          </select>
        </div>
        <p className="mt-1.5 text-[13px] leading-snug text-ink-soft">
          {changed ? (
            <>
              You changed this from the AI’s {ai ? `${ai.code} ${ai.name}` : line.ai_account_code}.{' '}
              {editable && (
                <button className="underline hover:text-ink" onClick={() => onPatch({ account_code: line.ai_account_code, tax_code: line.ai_tax_code })}>
                  Use the AI’s suggestion
                </button>
              )}
            </>
          ) : line.ai_reason ? (
            <>
              <span className={`num mr-1.5 font-medium ${conf != null && conf < 0.75 ? 'text-amber' : 'text-bottle'}`}>
                AI {conf != null ? `${Math.round(conf * 100)}%` : ''}
              </span>
              {line.ai_reason}
            </>
          ) : null}
        </p>
      </div>
    </li>
  );
}

const LEVEL_STYLE: Record<Check['level'], string> = {
  error: 'border-red-ink bg-red-wash text-red-ink',
  warning: 'border-amber bg-amber-wash text-[#7a4504]',
  info: 'border-slate bg-slate-wash text-slate',
};

function Checks({ checks, onPick }: { checks: Check[]; onPick: (c: Check) => void }) {
  if (!checks.length) {
    return <p className="rounded-md border-l-[3px] border-bottle bg-bottle-wash px-3 py-2.5 text-[14px] text-bottle">Every check passed: totals add up, GST matches the tax codes, and the ABN is valid.</p>;
  }
  const order = { error: 0, warning: 1, info: 2 };
  return (
    <ul className="space-y-1.5">
      {[...checks].sort((a, b) => order[a.level] - order[b.level]).map((c) => (
        <li key={c.id}>
          <button onClick={() => onPick(c)} className={`w-full rounded-md border-l-[3px] px-3 py-2 text-left text-[14px] leading-snug ${LEVEL_STYLE[c.level]} ${c.field || c.line ? 'hover:brightness-[0.97]' : 'cursor-default'}`}>
            {c.message}
          </button>
        </li>
      ))}
    </ul>
  );
}

function Timeline({ events }: { events: Invoice['events'] }) {
  return (
    <ol className="space-y-2.5">
      {events.map((e, i) => (
        <li key={i} className="grid grid-cols-[6.5rem_1fr] gap-3 text-[14px]">
          <span className="num text-[13px] text-ink-faint">{dateTime(e.at)}</span>
          <span className="text-ink-soft">{e.message}</span>
        </li>
      ))}
    </ol>
  );
}

function Actions({ inv, busy, act }: { inv: Invoice; busy: string | null; act: (what: 'approve' | 'reject' | 'post' | 'retry') => void }) {
  if (inv.status === 'needs_review') {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn btn-primary" disabled={!!busy || inv.errors > 0} onClick={() => act('approve')}>
          {busy === 'approve' ? 'Approving…' : 'Approve'}
        </button>
        <button className="btn btn-danger" disabled={!!busy} onClick={() => act('reject')}>
          Reject
        </button>
        {inv.errors > 0 && <span className="text-[14px] text-red-ink">Fix {inv.errors === 1 ? 'the error' : `the ${inv.errors} errors`} above to approve.</span>}
      </div>
    );
  }
  if (inv.status === 'approved') {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn btn-primary" disabled={!!busy} onClick={() => act('post')}>
          {busy === 'post' ? 'Posting to MYOB…' : 'Post to MYOB'}
        </button>
        <span className="text-[14px] text-ink-soft">Creates a bill in MYOB. Safe to click twice.</span>
      </div>
    );
  }
  if (inv.status === 'posting') {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn btn-quiet" disabled={!!busy} onClick={() => act('retry')}>
          {busy === 'retry' ? 'Retrying…' : 'Retry now'}
        </button>
        <span className="text-[14px] text-ink-soft">
          MYOB did not accept it yet. It retries automatically{inv.sync ? ` from ${dateTime(inv.sync.next_attempt_at)}` : ''}.
        </span>
      </div>
    );
  }
  if (inv.status === 'failed') {
    return (
      <div className="space-y-3">
        <p className="rounded-md bg-red-wash px-3 py-2.5 text-[14px] text-red-ink">{inv.last_error}</p>
        <p className="text-[14px] text-ink-soft">Change what MYOB rejected above, approve it again, then post. Or retry as it is.</p>
        <button className="btn btn-quiet" disabled={!!busy} onClick={() => act('post')}>
          {busy === 'post' ? 'Posting…' : 'Retry as it is'}
        </button>
      </div>
    );
  }
  if (inv.status === 'posted') {
    return (
      <p className="text-[14px] text-ink-soft">
        In MYOB as bill <span className="num font-medium text-ink">{inv.myob_bill_uid?.slice(0, 8)}</span>
        {inv.posted_at ? `, posted ${dateTime(inv.posted_at)}` : ''}.{' '}
        <Link to="/reconcile" className="underline hover:text-ink">
          Check it against MYOB
        </Link>
      </p>
    );
  }
  if (inv.status === 'rejected') return <p className="text-[14px] text-ink-soft">Rejected. It will not be posted.</p>;
  return null;
}

function Review({ invoice, setInvoice }: { invoice: Invoice; setInvoice: (i: Invoice) => void }) {
  const accounts = useResource<Account[]>('/accounts');
  const [active, setActive] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editable = EDITABLE.includes(invoice.status);

  const regions: Region[] = useMemo(() => {
    const r: Region[] = [];
    for (const [k, box] of Object.entries(invoice.boxes)) if (box) r.push({ key: `field:${k}`, box });
    for (const l of invoice.lines) if (l.box) r.push({ key: `line:${l.position}`, box: l.box });
    return r;
  }, [invoice.boxes, invoice.lines]);

  const flagFor = (pred: (c: Check) => boolean): Check['level'] | null => {
    const hits = invoice.checks.filter(pred).filter((c) => c.level !== 'info');
    return hits.some((c) => c.level === 'error') ? 'error' : hits.length ? 'warning' : null;
  };

  async function patch(p: InvoicePatch) {
    setSaving(true);
    setError(null);
    try {
      setInvoice(await api<Invoice>(`/invoices/${invoice.id}`, { method: 'PATCH', json: p }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function saveField(key: HeaderField, raw: string) {
    const isMoney = ['subtotal', 'tax', 'total'].includes(key);
    const value = raw.trim() === '' ? null : isMoney ? Number(raw.replace(/[^0-9.-]/g, '')) : key === 'supplier_abn' ? raw.replace(/\D/g, '') : raw.trim();
    void patch({ [key]: value } as InvoicePatch);
  }

  async function act(what: 'approve' | 'reject' | 'post' | 'retry') {
    setBusy(what);
    setError(null);
    try {
      if (what === 'reject') {
        const reason = prompt('Why are you rejecting this invoice? (optional)');
        if (reason === null) return;
        setInvoice(await api<Invoice>(`/invoices/${invoice.id}/reject`, { method: 'POST', json: { reason } }));
      } else if (what === 'retry') {
        await api('/sync/run', { method: 'POST' });
        setInvoice(await api<Invoice>(`/invoices/${invoice.id}`));
      } else {
        setInvoice(await api<Invoice>(`/invoices/${invoice.id}/${what}`, { method: 'POST' }));
      }
    } catch (e) {
      setError((e as Error).message);
      setInvoice(await api<Invoice>(`/invoices/${invoice.id}`));
    } finally {
      setBusy(null);
    }
  }

  function pickCheck(c: Check) {
    if (c.field) {
      setActive(`field:${c.field}`);
      document.getElementById(`f-${c.field}`)?.focus();
    } else if (c.line) {
      setActive(`line:${c.line}`);
      document.getElementById(`line-${c.line}-account`)?.focus();
    }
  }

  function pickRegion(key: string) {
    setActive(key);
    const [kind, name] = key.split(':');
    const el = document.getElementById(kind === 'field' ? `f-${name}` : `line-${name}`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (kind === 'field') (el as HTMLInputElement | null)?.focus({ preventScroll: true });
  }

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <Link to="/" className="text-[14px] text-ink-soft hover:text-ink">
            All invoices
          </Link>
          <h1 className="mt-1 text-[28px] leading-tight font-semibold tracking-[-0.02em]">{invoice.supplier_name ?? invoice.file_name}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-ink-soft">
            <span className="num">{invoice.invoice_number ? `Invoice ${invoice.invoice_number}` : 'No invoice number'}</span>
            <span className="num">due {date(invoice.due_date)}</span>
            <StatusPill status={invoice.status} />
            {!invoice.supplier_known && invoice.supplier_name && <span className="text-[13px] text-slate">New supplier</span>}
          </p>
        </div>
        <p className="num text-[30px] font-semibold tracking-[-0.02em]">{money(invoice.total)}</p>
      </div>

      <div className="mt-6 grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto lg:pb-4">
          <DocumentViewer url={invoice.file_url} mime={invoice.file_mime} pages={invoice.pages} regions={regions} active={active} onPick={pickRegion} />
          <p className="mt-3 text-[13px] text-ink-faint">Click a field or line to see where it was read from. Click a box on the page to jump to its field.</p>
        </div>

        <div className="space-y-8">
          <section aria-label="Checks">
            <Checks checks={invoice.checks} onPick={pickCheck} />
            {invoice.ai_notes && (
              <p className="mt-2 rounded-md border-l-[3px] border-slate bg-slate-wash px-3 py-2 text-[14px] text-slate">
                <span className="font-medium">AI note: </span>
                {invoice.ai_notes}
              </p>
            )}
          </section>

          <section aria-labelledby="details-h">
            <div className="flex items-baseline justify-between">
              <h2 id="details-h" className="text-[17px] font-semibold">
                Details
              </h2>
              <span className="text-[13px] text-ink-faint" aria-live="polite">
                {saving ? 'Saving…' : editable ? 'Changes save as you go' : ''}
              </span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3">
              {FIELDS.map((f) => (
                <div key={f.key} className={f.wide ? 'col-span-2' : ''}>
                  <Field
                    inv={invoice}
                    def={f}
                    editable={editable}
                    flagged={flagFor((c) => c.field === f.key)}
                    onFocus={() => setActive(`field:${f.key}`)}
                    onSave={(v) => saveField(f.key, v)}
                  />
                </div>
              ))}
            </div>
          </section>

          <section aria-labelledby="lines-h">
            <h2 id="lines-h" className="text-[17px] font-semibold">
              Lines and accounts
            </h2>
            <ul className="mt-2 border-t-[1.5px] border-ink">
              {invoice.lines.map((l) => (
                <LineRow
                  key={l.id}
                  line={l}
                  accounts={accounts.data ?? []}
                  editable={editable}
                  active={active === `line:${l.position}`}
                  flagged={flagFor((c) => c.line === l.position)}
                  onFocus={() => setActive(`line:${l.position}`)}
                  onPatch={(p) => void patch({ lines: [{ id: l.id, ...p }] })}
                />
              ))}
            </ul>
            <div className="mt-4 grid grid-cols-3 gap-3 sm:ml-auto sm:max-w-md">
              {TOTAL_FIELDS.map((f) => (
                <Field
                  key={f.key}
                  inv={invoice}
                  def={{ ...f, type: 'money' }}
                  editable={editable}
                  flagged={flagFor((c) => c.field === f.key)}
                  onFocus={() => setActive(`field:${f.key}`)}
                  onSave={(v) => saveField(f.key, v)}
                />
              ))}
            </div>
          </section>

          <section className="sticky bottom-0 -mx-4 border-t border-rule bg-paper/95 px-4 py-4 backdrop-blur sm:mx-0 sm:px-0" aria-label="Actions">
            {error && (
              <p className="mb-3 rounded-md bg-red-wash px-3 py-2 text-[14px] text-red-ink" role="alert">
                {error}
              </p>
            )}
            <Actions inv={invoice} busy={busy} act={act} />
          </section>

          {invoice.sync && (
            <section aria-labelledby="sync-h">
              <h2 id="sync-h" className="text-[17px] font-semibold">
                Calls to MYOB
              </h2>
              <div className="mt-3">
                <SyncLog log={invoice.sync.log} />
              </div>
            </section>
          )}

          <section aria-labelledby="history-h">
            <h2 id="history-h" className="text-[17px] font-semibold">
              History
            </h2>
            <div className="mt-3">
              <Timeline events={invoice.events} />
            </div>
            <p className="mt-4 text-[13px] text-ink-faint">
              {invoice.extract_ms != null ? `Read in ${seconds(invoice.extract_ms)}` : 'Read'} by Azure AI Document Intelligence. Accounts suggested in{' '}
              {seconds(invoice.code_ms)} by Azure OpenAI
              {invoice.ai_tokens ? ` using ${invoice.ai_tokens.toLocaleString()} tokens` : ''}.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}

export function InvoicePage() {
  const { id } = useParams();
  const { data, error, set } = useResource<Invoice>(`/invoices/${id}`);

  if (error) return <p className="py-20 text-center text-ink-soft">{error}. <Link className="underline" to="/">Back to invoices</Link></p>;
  if (!data) return <div className="h-96 animate-pulse rounded bg-rule-soft" />;

  if (data.status === 'uploaded' || data.status === 'extracted') {
    return (
      <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1fr)]">
        <div className="order-2 lg:order-1">
          <DocumentViewer url={data.file_url} mime={data.file_mime} pages={[]} regions={[]} active={null} />
        </div>
        <div className="order-1 lg:order-2 lg:pt-8">
          <Processing invoice={data} onDone={set} />
        </div>
      </div>
    );
  }
  return <Review invoice={data} setInvoice={set} />;
}
