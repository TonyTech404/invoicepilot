import { describe, expect, it } from 'vitest';
import { compare } from '../src/reconcile.js';

const app = (n: string, total: number, bill_uid: string) => ({ invoice_id: `inv-${n}`, supplier: 'Packwell', invoice_number: n, total, bill_uid });
const bill = (uid: string, n: string | null, total: number, source: 'api' | 'manual' = 'api') => ({
  uid,
  number: uid.toUpperCase(),
  supplier_uid: 'sup-1',
  supplier: 'Packwell',
  supplier_invoice_number: n,
  total,
  source,
});

describe('reconcile', () => {
  it('matches bills that agree', () => {
    const rows = compare([app('1', 110, 'b1')], [bill('b1', '1', 110)]);
    expect(rows.map((r) => r.kind)).toEqual(['matched']);
  });

  it('finds a duplicate posting of the same supplier invoice', () => {
    const rows = compare([app('1', 110, 'b1')], [bill('b1', '1', 110), bill('b2', '1', 110)]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('duplicate_in_myob');
    expect(rows[0].myob_bill_uids).toEqual(['b1', 'b2']);
  });

  it('explains small gaps as GST rounding and big ones as edits', () => {
    expect(compare([app('1', 110, 'b1')], [bill('b1', '1', 110.03)])[0].note).toMatch(/rounds GST/);
    expect(compare([app('1', 110, 'b1')], [bill('b1', '1', 154)])[0].note).toMatch(/Out by \$44.00/);
  });

  it('reports bills deleted from MYOB and bills entered by hand', () => {
    const rows = compare([app('1', 110, 'gone')], [bill('m1', 'X-9', 50, 'manual')]);
    expect(rows.map((r) => r.kind)).toEqual(['missing_in_myob', 'myob_only']);
  });
});
