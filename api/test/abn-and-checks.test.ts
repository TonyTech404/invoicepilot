import { describe, expect, it } from 'vitest';
import { formatAbn, isValidAbn } from '../src/lib/abn.js';
import { runChecks, hasErrors, type CheckInput } from '../src/checks.js';

describe('ABN checksum', () => {
  it('accepts the ATO worked example', () => {
    expect(isValidAbn('51 824 753 556')).toBe(true);
  });

  it('rejects a one-digit typo', () => {
    expect(isValidAbn('51 824 753 557')).toBe(false);
  });

  it('rejects the wrong length and empty input', () => {
    expect(isValidAbn('5182475355')).toBe(false);
    expect(isValidAbn(null)).toBe(false);
  });

  it('formats as NN NNN NNN NNN', () => {
    expect(formatAbn('51824753556')).toBe('51 824 753 556');
  });
});

const base: CheckInput = {
  supplier_name: 'Packwell Packaging Pty Ltd',
  supplier_abn: '51824753556',
  supplier_known: true,
  invoice_number: '50213',
  invoice_date: '2026-11-06',
  due_date: '2026-12-06',
  subtotal: 100,
  tax: 10,
  total: 110,
  confidence: {},
  lines: [
    { position: 1, amount: 60, tax_code: 'GST', account_code: '5-1300', ai_account_code: '5-1300', ai_confidence: 0.98, read_confidence: 0.95 },
    { position: 2, amount: 40, tax_code: 'GST', account_code: '5-1300', ai_account_code: '5-1300', ai_confidence: 0.97, read_confidence: 0.95 },
  ],
  accounts: [
    { code: '5-1300', name: 'Packaging & Labels', active: true },
    { code: '6-1900', name: 'Equipment Hire', active: false },
  ],
  duplicateOf: null,
  today: '2026-11-19',
};

const ids = (input: CheckInput) => runChecks(input).map((c) => c.id);

describe('invoice checks', () => {
  it('passes a clean invoice', () => {
    expect(runChecks(base)).toEqual([]);
  });

  it('catches lines that do not add up to the subtotal', () => {
    const checks = runChecks({ ...base, subtotal: 120, total: 132, tax: 12 });
    expect(checks.map((c) => c.id)).toContain('lines_vs_subtotal');
    expect(hasErrors(checks)).toBe(true);
  });

  it('catches subtotal + GST not matching the total', () => {
    expect(ids({ ...base, total: 111 })).toContain('subtotal_plus_tax');
  });

  it('warns when GST does not match the tax codes', () => {
    const lines = base.lines.map((l) => ({ ...l, tax_code: 'FRE' as const }));
    expect(ids({ ...base, lines })).toContain('gst_vs_codes');
  });

  it('tolerates per-line rounding in GST', () => {
    expect(ids({ ...base, tax: 10.03, total: 110.03 })).not.toContain('gst_vs_codes');
  });

  it('blocks a duplicate supplier invoice number', () => {
    const checks = runChecks({ ...base, duplicateOf: { invoice_number: '50213', status: 'posted', created_at: '2026-11-07' } });
    expect(checks.find((c) => c.id === 'duplicate')?.level).toBe('error');
  });

  it('blocks an inactive account', () => {
    const lines = [{ ...base.lines[0], amount: 100, account_code: '6-1900' }];
    expect(ids({ ...base, lines })).toContain('line_1_inactive');
  });

  it('warns about a bad ABN but does not block', () => {
    const checks = runChecks({ ...base, supplier_abn: '51824753557' });
    expect(checks.find((c) => c.id === 'abn_invalid')?.level).toBe('warning');
    expect(hasErrors(checks)).toBe(false);
  });

  it('flags unsure AI suggestions only while the reviewer has not changed them', () => {
    const unsure = [{ ...base.lines[0], ai_confidence: 0.6 }, base.lines[1]];
    expect(ids({ ...base, lines: unsure })).toContain('line_1_unsure');
    const changed = [{ ...unsure[0], account_code: '6-1100' }, base.lines[1]];
    expect(ids({ ...base, lines: changed, accounts: [...base.accounts, { code: '6-1100', name: 'R&M', active: true }] })).not.toContain('line_1_unsure');
  });

  it('ignores a hard-to-read supplier name once the supplier is matched by ABN', () => {
    expect(ids({ ...base, confidence: { supplier_name: 0.6 } })).not.toContain('low_read_confidence');
    expect(ids({ ...base, supplier_known: false, confidence: { supplier_name: 0.6 } })).toContain('low_read_confidence');
  });

  it('requires the key fields', () => {
    expect(ids({ ...base, invoice_number: null })).toContain('missing_invoice_number');
  });
});
