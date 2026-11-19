// A stand-in for the MYOB AccountRight API, backed by the myob_* tables.
//
// It follows the real API's shapes closely enough that the client in ./client.ts
// would work against api.myob.com with a different transport:
//   - resources under /accountright/{companyFileId}/...
//   - 201 Created with a Location header and no body on POST
//   - OData-style $filter on GET, results wrapped in { Items, NextPageLink, Count }
//   - errors as { Errors: [{ Name, Message, Severity }] }
//   - rate limits answered with 403 "Developer Over Qps" (not 429), as MYOB's gateway does
//
// The workspace's "MYOB connection" setting decides how badly it behaves.
import { Hono } from 'hono';
import { db } from '../db.js';
import { cents } from '../lib/money.js';
import type { MyobMode } from '../../../shared/types.js';

export const MOCK_BASE = 'https://api.myob.example/accountright';

/** Set on a response when a POST created the first bill for a supplier invoice number. */
export const FIRST_CREATE_HEADER = 'x-mock-first-create';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const errorBody = (name: string, message: string) => ({
  Errors: [{ Name: name, Message: message, AdditionalDetails: '', ErrorCode: 0, Severity: 'Error' }],
});

/** Parses `Field eq 'x' and Other/Path eq guid'...'` into pairs. Enough for the filters we send. */
export function parseFilter(filter: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!filter) return out;
  for (const m of filter.matchAll(/([\w/]+)\s+eq\s+(?:guid)?'((?:[^']|'')*)'/g)) out[m[1]] = m[2].replace(/''/g, "'");
  return out;
}

interface BillRow {
  uid: string;
  number: string;
  supplier_uid: string;
  supplier_name: string;
  supplier_invoice_number: string | null;
  date: string;
  is_tax_inclusive: boolean;
  subtotal: number;
  tax: number;
  total: number;
  lines: Array<{ description: string; total: number; account_uid: string; account_code: string; account_name: string; tax_uid: string; tax_code: string }>;
  comment: string | null;
  row_version: number;
}

function billJson(base: string, b: BillRow) {
  return {
    UID: b.uid,
    Number: b.number,
    Date: `${b.date}T00:00:00`,
    SupplierInvoiceNumber: b.supplier_invoice_number,
    Supplier: { UID: b.supplier_uid, Name: b.supplier_name, URI: `${base}/Contact/Supplier/${b.supplier_uid}` },
    IsTaxInclusive: b.is_tax_inclusive,
    Lines: b.lines.map((l, i) => ({
      RowID: i + 1,
      Type: 'Transaction',
      Description: l.description,
      Total: l.total,
      Account: { UID: l.account_uid, DisplayID: l.account_code, Name: l.account_name },
      TaxCode: { UID: l.tax_uid, Code: l.tax_code },
    })),
    Subtotal: b.subtotal,
    TotalTax: b.tax,
    TotalAmount: b.total,
    Comment: b.comment,
    Status: 'Open',
    URI: `${base}/Purchase/Bill/Service/${b.uid}`,
    RowVersion: String(b.row_version),
  };
}

type Env = { Variables: { cf: string; base: string } };

export const myobMock = new Hono<Env>().basePath('/accountright/:cf');

// Auth, company file, simulated latency and the "flaky" mode.
myobMock.use('*', async (c, next) => {
  if (!c.req.header('authorization')?.startsWith('Bearer ') || !c.req.header('x-myobapi-key')) {
    return c.json(errorBody('OAuthTokenIsInvalid', 'The access token is missing or invalid.'), 401);
  }
  const cf = c.req.param('cf')!;
  const [ws] = await db()<{ myob_mode: MyobMode }[]>`select myob_mode from workspaces where company_file_id = ${cf}::uuid`;
  if (!ws) return c.json(errorBody('CompanyFileNotFound', 'No company file with that ID.'), 404);

  await sleep(120 + Math.random() * 230);
  if (ws.myob_mode === 'flaky') {
    const roll = Math.random();
    if (roll < 0.3) return c.text('<h1>Developer Over Qps</h1>', 403, { 'x-error-detail-header': 'Account Over Queries Per Second Limit' });
    if (roll < 0.45) return c.json(errorBody('ServiceUnavailable', 'The service is temporarily unavailable. Try again later.'), 503);
  }
  c.set('cf', cf);
  c.set('base', `${MOCK_BASE}/${cf}`);
  await next();
});

// ── Suppliers ───────────────────────────────────────────────────────────────

myobMock.get('/Contact/Supplier', async (c) => {
  const f = parseFilter(c.req.query('$filter'));
  const abn = f['BuyingDetails/ABN']?.replace(/\D/g, '') ?? null;
  const rows = await db()<{ uid: string; name: string; abn: string | null }[]>`
    select uid, name, abn from myob_suppliers
    where company_file_id = ${c.get('cf')}::uuid
      and (${abn}::text is null or abn = ${abn})
    order by name`;
  return c.json({
    Items: rows.map((s) => ({ UID: s.uid, CompanyName: s.name, IsIndividual: false, BuyingDetails: { ABN: s.abn }, URI: `${c.get('base')}/Contact/Supplier/${s.uid}` })),
    NextPageLink: null,
    Count: rows.length,
  });
});

myobMock.post('/Contact/Supplier', async (c) => {
  const body = (await c.req.json()) as { CompanyName?: string; BuyingDetails?: { ABN?: string } };
  if (!body.CompanyName) return c.json(errorBody('ValidationError', 'CompanyName is required.'), 400);
  const [row] = await db()<{ uid: string }[]>`
    insert into myob_suppliers (company_file_id, name, abn)
    values (${c.get('cf')}::uuid, ${body.CompanyName}, ${body.BuyingDetails?.ABN?.replace(/\D/g, '') || null})
    returning uid`;
  return c.body(null, 201, { Location: `${c.get('base')}/Contact/Supplier/${row.uid}` });
});

// ── Bills ───────────────────────────────────────────────────────────────────

async function loadBills(cf: string, where: { uid?: string; supplierInvoiceNumber?: string; supplierUid?: string }) {
  return db()<BillRow[]>`
    select b.uid, b.number, b.supplier_uid, s.name as supplier_name, b.supplier_invoice_number, b.date,
           b.is_tax_inclusive, b.subtotal, b.tax, b.total, b.lines, b.comment, b.row_version
    from myob_bills b join myob_suppliers s on s.uid = b.supplier_uid
    where b.company_file_id = ${cf}::uuid
      and (${where.uid ?? null}::uuid is null or b.uid = ${where.uid ?? null}::uuid)
      and (${where.supplierInvoiceNumber ?? null}::text is null or b.supplier_invoice_number = ${where.supplierInvoiceNumber ?? null})
      and (${where.supplierUid ?? null}::uuid is null or b.supplier_uid = ${where.supplierUid ?? null}::uuid)
    order by b.created_at`;
}

myobMock.get('/Purchase/Bill/Service', async (c) => {
  const f = parseFilter(c.req.query('$filter'));
  const rows = await loadBills(c.get('cf'), { supplierInvoiceNumber: f.SupplierInvoiceNumber, supplierUid: f['Supplier/UID'] });
  return c.json({ Items: rows.map((b) => billJson(c.get('base'), b)), NextPageLink: null, Count: rows.length });
});

myobMock.get('/Purchase/Bill/Service/:uid', async (c) => {
  const [row] = await loadBills(c.get('cf'), { uid: c.req.param('uid') });
  if (!row) return c.json(errorBody('NotFound', 'The bill was not found.'), 404);
  return c.json(billJson(c.get('base'), row));
});

// The chart of accounts and tax codes are fixed reference data: load them once per host.
let reference: Promise<{
  accounts: Map<string, { myob_uid: string; code: string; name: string; active: boolean }>;
  taxCodes: Map<string, { myob_uid: string; code: string; rate: number }>;
}> | null = null;

function referenceData() {
  reference ??= (async () => {
    const [accounts, taxes] = await Promise.all([
      db()<{ myob_uid: string; code: string; name: string; active: boolean }[]>`select myob_uid, code, name, active from accounts`,
      db()<{ myob_uid: string; code: string; rate: number }[]>`select myob_uid, code, rate from tax_codes`,
    ]);
    return { accounts: new Map(accounts.map((a) => [a.myob_uid, a])), taxCodes: new Map(taxes.map((t) => [t.myob_uid, t])) };
  })().catch((e) => {
    reference = null;
    throw e;
  });
  return reference;
}

interface BillRequest {
  Date?: string;
  SupplierInvoiceNumber?: string;
  Supplier?: { UID?: string };
  IsTaxInclusive?: boolean;
  Comment?: string;
  Lines?: Array<{ Type?: string; Description?: string; Total?: number; Account?: { UID?: string }; TaxCode?: { UID?: string } }>;
}

myobMock.post('/Purchase/Bill/Service', async (c) => {
  const cf = c.get('cf');
  const body = (await c.req.json()) as BillRequest;
  const sql = db();

  if (!body.Date) return c.json(errorBody('ValidationError', 'Date is required.'), 400);
  if (!body.Supplier?.UID) return c.json(errorBody('ValidationError', 'Supplier is required.'), 400);
  if (!body.Lines?.length) return c.json(errorBody('ValidationError', 'A bill needs at least one line.'), 400);

  const [supplier] = await sql`select uid from myob_suppliers where uid = ${body.Supplier.UID}::uuid and company_file_id = ${cf}::uuid`;
  if (!supplier) return c.json(errorBody('ValidationError', 'The supplier was not found in this company file.'), 400);

  const { accounts, taxCodes } = await referenceData();

  const lines: Array<{ description: string; total: number; account_uid: string; account_code: string; account_name: string; tax_uid: string; tax_code: string; rate: number }> = [];
  for (const [i, l] of body.Lines.entries()) {
    const account = accounts.get(l.Account?.UID ?? '');
    const tax = taxCodes.get(l.TaxCode?.UID ?? '');
    if (!account) return c.json(errorBody('ValidationError', `Line ${i + 1}: the account was not found.`), 400);
    if (!account.active) return c.json(errorBody('InactiveAccount', `Line ${i + 1}: account ${account.code} ${account.name} is inactive.`), 400);
    if (!tax) return c.json(errorBody('ValidationError', `Line ${i + 1}: the tax code was not found.`), 400);
    lines.push({
      description: l.Description ?? '',
      total: cents(Number(l.Total ?? 0)),
      account_uid: account.myob_uid,
      account_code: account.code,
      account_name: account.name,
      tax_uid: tax.myob_uid,
      tax_code: tax.code,
      rate: Number(tax.rate),
    });
  }

  // MYOB works GST out per line from the tax code, so its total can differ from the paper by a cent or two.
  const subtotal = cents(lines.reduce((s, l) => s + l.total, 0));
  const tax = cents(lines.reduce((s, l) => s + cents((l.total * l.rate) / 100), 0));
  const date = body.Date.slice(0, 10);

  const result = await sql.begin(async (tx) => {
    const [{ existing }] = await tx<{ existing: number }[]>`
      select count(*)::int as existing from myob_bills
      where company_file_id = ${cf}::uuid and supplier_uid = ${body.Supplier!.UID!}::uuid
        and supplier_invoice_number = ${body.SupplierInvoiceNumber ?? null}`;
    const [{ next }] = await tx<{ next: number }[]>`select count(*)::int + 1 as next from myob_bills where company_file_id = ${cf}::uuid`;
    const [row] = await tx<{ uid: string }[]>`
      insert into myob_bills (company_file_id, number, supplier_uid, supplier_invoice_number, date, is_tax_inclusive,
                              subtotal, tax, total, lines, comment, source)
      values (${cf}::uuid, ${String(next + 200).padStart(8, '0')}, ${body.Supplier!.UID!}::uuid, ${body.SupplierInvoiceNumber ?? null},
              ${date}, ${body.IsTaxInclusive ?? false}, ${subtotal}, ${tax}, ${cents(subtotal + tax)},
              ${tx.json(lines.map(({ rate: _rate, ...l }) => l))}, ${body.Comment ?? null}, 'api')
      returning uid`;
    return { uid: row.uid, first: existing === 0 };
  });

  const headers: Record<string, string> = { Location: `${c.get('base')}/Purchase/Bill/Service/${result.uid}` };
  if (result.first) headers[FIRST_CREATE_HEADER] = '1';
  return c.body(null, 201, headers);
});

// Read-only reference lists, handy when poking at the mock.
myobMock.get('/GeneralLedger/Account', async (c) => {
  const rows = await db()<{ myob_uid: string; code: string; name: string; active: boolean }[]>`select myob_uid, code, name, active from accounts order by code`;
  return c.json({ Items: rows.map((a) => ({ UID: a.myob_uid, DisplayID: a.code, Name: a.name, IsActive: a.active })), NextPageLink: null, Count: rows.length });
});

myobMock.get('/GeneralLedger/TaxCode', async (c) => {
  const rows = await db()<{ myob_uid: string; code: string; name: string; rate: number }[]>`select myob_uid, code, name, rate from tax_codes order by code`;
  return c.json({ Items: rows.map((t) => ({ UID: t.myob_uid, Code: t.code, Description: t.name, Rate: Number(t.rate) })), NextPageLink: null, Count: rows.length });
});
