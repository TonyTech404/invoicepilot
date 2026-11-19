import { describe, expect, it } from 'vitest';
import { cleanVendorName, mapInvoice, type DiResult } from '../src/docintel.js';
import highland from './fixtures/di-highland-green.json' with { type: 'json' };
import receipt from './fixtures/di-sparkline-receipt.json' with { type: 'json' };

// Fixtures are real Document Intelligence responses for two of the sample invoices,
// trimmed to the fields the app reads.

describe('cleanVendorName', () => {
  it('drops logo text when a legal name is present', () => {
    expect(cleanVendorName('Highland Green\nCOFFEE TRADERS\nHighland Green Coffee Traders Pty Ltd')).toBe('Highland Green Coffee Traders Pty Ltd');
  });

  it('joins and title-cases an all-caps name', () => {
    expect(cleanVendorName('SPARKLINE\nCLEANING SUPPLIES')).toBe('Sparkline Cleaning Supplies');
  });
});

describe('mapInvoice', () => {
  it('maps a PDF invoice with mixed GST', () => {
    const x = mapInvoice(highland as unknown as DiResult);
    expect(x.values).toMatchObject({
      supplier_name: 'Highland Green Coffee Traders Pty Ltd',
      supplier_abn: '58607182954',
      invoice_number: 'HGC-24817',
      invoice_date: '2026-11-03',
      due_date: '2026-12-03',
      po_number: 'PO-1042',
      subtotal: 11241,
      tax: 28.5,
      total: 11269.5,
      currency: 'AUD',
    });
    expect(x.lines).toHaveLength(4);
    expect(x.lines.map((l) => l.amount)).toEqual([4452, 3674, 2830, 285]);
    expect(x.lines[0].tax_hint).toBe('Free');
    expect(x.lines[3].tax_hint).toBe('10%');
    expect(x.pages[0].unit).toBe('inch');
    expect(x.boxes.total?.polygon).toHaveLength(8);
  });

  it('maps a phone photo of a receipt', () => {
    const x = mapInvoice(receipt as unknown as DiResult);
    expect(x.values.total).toBe(212.52);
    expect(x.values.supplier_name).toBe('Sparkline Cleaning Supplies');
    expect(x.pages[0].unit).toBe('pixel');
    // The skewed first line loses words; its low confidence is what tells the reviewer.
    expect(x.lines[0].read_confidence).toBeLessThan(0.7);
  });

  it('derives a missing subtotal from the lines and marks it unsure', () => {
    const fields = { ...(highland as unknown as DiResult).fields };
    delete fields.SubTotal;
    const x = mapInvoice({ ...(highland as unknown as DiResult), fields });
    expect(x.values.subtotal).toBe(11241);
    expect(x.confidence.subtotal).toBe(0.5);
  });
});
