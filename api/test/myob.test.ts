import { describe, expect, it } from 'vitest';
import { MyobClient, MyobError, type Transport } from '../src/myob/client.js';
import { parseFilter } from '../src/myob/mock.js';
import { backoffMs } from '../src/sync.js';

const config = { baseUrl: 'https://api.myob.example/accountright/cf', accessToken: 't', apiKey: 'k', timeoutMs: 50 };

function client(respond: (req: Request) => Response | Promise<Response>, seen: Request[] = []) {
  const transport: Transport = async (req) => {
    seen.push(req);
    return respond(req);
  };
  return new MyobClient(transport, config);
}

async function errorFrom(p: Promise<unknown>): Promise<MyobError> {
  try {
    await p;
  } catch (e) {
    return e as MyobError;
  }
  throw new Error('expected a MyobError');
}

const bill = { date: '2026-11-03', supplierUid: 'sup', supplierInvoiceNumber: 'A-1', lines: [{ description: 'x', total: 10, accountUid: 'a', taxCodeUid: 't' }] };

describe('MyobClient', () => {
  it('sends MYOB auth headers and reads the UID from Location', async () => {
    const seen: Request[] = [];
    const c = client(() => new Response(null, { status: 201, headers: { Location: 'https://api.myob.example/accountright/cf/Purchase/Bill/Service/abc-123' } }), seen);
    await expect(c.createBill(bill)).resolves.toBe('abc-123');
    expect(seen[0].headers.get('authorization')).toBe('Bearer t');
    expect(seen[0].headers.get('x-myobapi-key')).toBe('k');
    expect(seen[0].headers.get('x-myobapi-version')).toBe('v2');
  });

  it('treats 403 "Developer Over Qps" as a rate limit, not an auth failure', async () => {
    const c = client(() => new Response('<h1>Developer Over Qps</h1>', { status: 403 }));
    const err = await errorFrom(c.createBill(bill));
    expect(err.kind).toBe('rate_limited');
    expect(err.transient).toBe(true);
    expect(err.uncertain).toBe(false);
  });

  it('marks a timeout as uncertain: the bill may exist', async () => {
    const c = client(() => new Promise<Response>(() => {}));
    const err = await errorFrom(c.createBill(bill));
    expect(err.kind).toBe('timeout');
    expect(err.uncertain).toBe(true);
  });

  it('does not retry validation errors and keeps MYOB’s message', async () => {
    const c = client(() => Response.json({ Errors: [{ Name: 'InactiveAccount', Message: 'Line 1: account 6-1900 is inactive.' }] }, { status: 400 }));
    const err = await errorFrom(c.createBill(bill));
    expect(err.kind).toBe('validation');
    expect(err.transient).toBe(false);
    expect(err.message).toContain('6-1900');
  });

  it('escapes quotes in OData filters', async () => {
    const seen: Request[] = [];
    const c = client(() => Response.json({ Items: [], NextPageLink: null, Count: 0 }), seen);
    await c.findBills('11111111-1111-1111-1111-111111111111', "O'Brien-7");
    const filter = new URL(seen[0].url).searchParams.get('$filter');
    expect(filter).toBe("SupplierInvoiceNumber eq 'O''Brien-7' and Supplier/UID eq guid'11111111-1111-1111-1111-111111111111'");
    expect(parseFilter(filter!)).toEqual({ SupplierInvoiceNumber: "O'Brien-7", 'Supplier/UID': '11111111-1111-1111-1111-111111111111' });
  });
});

describe('backoff', () => {
  it('grows exponentially, with jitter, and is capped', () => {
    expect(backoffMs(1, 0.5)).toBe(500);
    expect(backoffMs(2, 0.5)).toBe(1000);
    expect(backoffMs(3, 0.5)).toBe(2000);
    expect(backoffMs(10, 0.5)).toBe(8000);
    expect(backoffMs(2, 0)).toBe(750);
    expect(backoffMs(2, 1)).toBe(1250);
  });
});
