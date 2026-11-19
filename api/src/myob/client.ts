// MYOB AccountRight API client.
//
// Written against MYOB's documented request shapes. It takes a transport (anything that
// turns a Request into a Response) so the same code runs against the mock in this repo or,
// with `fetch`, against https://api.myob.com.

export type Transport = (req: Request) => Promise<Response>;

export type MyobErrorKind =
  | 'rate_limited' // 403 Developer Over Qps, or 429: safe to retry, nothing was written
  | 'unavailable' //  503: safe to retry, nothing was written
  | 'timeout' //      no response: the request may or may not have been applied
  | 'server' //       other 5xx: may or may not have been applied
  | 'validation' //   400: retrying will not help, a person has to fix the data
  | 'auth' //         401: token expired or revoked
  | 'not_found';

export class MyobError extends Error {
  constructor(
    readonly kind: MyobErrorKind,
    readonly status: number | null,
    message: string,
  ) {
    super(message);
  }
  /** Retrying could succeed. */
  get transient() {
    return this.kind === 'rate_limited' || this.kind === 'unavailable' || this.kind === 'timeout' || this.kind === 'server';
  }
  /** The request may have been applied even though we got no success response. */
  get uncertain() {
    return this.kind === 'timeout' || this.kind === 'server';
  }
}

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`No response from MYOB within ${(ms / 1000).toFixed(1)}s`);
  }
}

export interface MyobConfig {
  baseUrl: string; // https://api.myob.com/accountright/{companyFileId}
  accessToken: string;
  apiKey: string;
  timeoutMs: number;
}

export interface BillLine {
  description: string;
  total: number;
  accountUid: string;
  taxCodeUid: string;
}

export interface NewBill {
  date: string;
  supplierUid: string;
  supplierInvoiceNumber: string;
  lines: BillLine[];
  comment?: string;
}

export interface MyobBill {
  UID: string;
  Number: string;
  SupplierInvoiceNumber: string | null;
  Supplier: { UID: string; Name: string };
  Subtotal: number;
  TotalTax: number;
  TotalAmount: number;
  Lines: Array<{ Description: string; Total: number; Account: { UID: string; DisplayID: string }; TaxCode: { UID: string; Code: string } }>;
}

interface Collection<T> {
  Items: T[];
  NextPageLink: string | null;
  Count: number;
}

const odata = (s: string) => s.replace(/'/g, "''");
const uidFrom = (location: string | null) => location?.split('/').pop() ?? null;

export class MyobClient {
  constructor(
    private readonly transport: Transport,
    private readonly config: MyobConfig,
  ) {}

  private async send(method: string, path: string, body?: unknown): Promise<Response> {
    const req = new Request(`${this.config.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.config.accessToken}`,
        'x-myobapi-key': this.config.apiKey,
        'x-myobapi-version': 'v2',
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    let res: Response;
    try {
      res = await withTimeout(this.transport(req), this.config.timeoutMs);
    } catch (err) {
      if (err instanceof TimeoutError) throw new MyobError('timeout', null, err.message);
      throw new MyobError('timeout', null, `Connection to MYOB failed: ${(err as Error).message}`);
    }
    if (res.ok) return res;

    const text = await res.text();
    const message = errorMessage(text) ?? `HTTP ${res.status}`;
    if (res.status === 429 || (res.status === 403 && /over qps|over rate|rate limit/i.test(text + (res.headers.get('x-error-detail-header') ?? ''))))
      throw new MyobError('rate_limited', res.status, 'MYOB rate limit (Developer Over Qps)');
    if (res.status === 503) throw new MyobError('unavailable', res.status, message);
    if (res.status >= 500) throw new MyobError('server', res.status, message);
    if (res.status === 401) throw new MyobError('auth', res.status, message);
    if (res.status === 404) throw new MyobError('not_found', res.status, message);
    throw new MyobError('validation', res.status, message);
  }

  async findSupplierByAbn(abn: string): Promise<string | null> {
    const res = await this.send('GET', `/Contact/Supplier?$filter=${encodeURIComponent(`BuyingDetails/ABN eq '${odata(abn)}'`)}`);
    const data = (await res.json()) as Collection<{ UID: string }>;
    return data.Items[0]?.UID ?? null;
  }

  async createSupplier(name: string, abn: string | null): Promise<string> {
    const res = await this.send('POST', '/Contact/Supplier', { CompanyName: name, IsIndividual: false, BuyingDetails: { ABN: abn ?? '' } });
    const uid = uidFrom(res.headers.get('location'));
    if (!uid) throw new MyobError('server', res.status, 'MYOB created the supplier but returned no Location');
    return uid;
  }

  async findBills(supplierUid: string, supplierInvoiceNumber: string): Promise<MyobBill[]> {
    const filter = `SupplierInvoiceNumber eq '${odata(supplierInvoiceNumber)}' and Supplier/UID eq guid'${supplierUid}'`;
    const res = await this.send('GET', `/Purchase/Bill/Service?$filter=${encodeURIComponent(filter)}`);
    return ((await res.json()) as Collection<MyobBill>).Items;
  }

  async getBill(uid: string): Promise<MyobBill> {
    const res = await this.send('GET', `/Purchase/Bill/Service/${uid}`);
    return (await res.json()) as MyobBill;
  }

  async createBill(bill: NewBill): Promise<string> {
    const res = await this.send('POST', '/Purchase/Bill/Service', {
      Date: `${bill.date}T00:00:00`,
      SupplierInvoiceNumber: bill.supplierInvoiceNumber,
      Supplier: { UID: bill.supplierUid },
      IsTaxInclusive: false,
      Comment: bill.comment,
      Lines: bill.lines.map((l) => ({
        Type: 'Transaction',
        Description: l.description.slice(0, 255),
        Total: l.total,
        Account: { UID: l.accountUid },
        TaxCode: { UID: l.taxCodeUid },
      })),
    });
    const uid = uidFrom(res.headers.get('location'));
    if (!uid) throw new MyobError('server', res.status, 'MYOB created the bill but returned no Location');
    return uid;
  }
}

function errorMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { Errors?: Array<{ Message?: string }> };
    return parsed.Errors?.map((e) => e.Message).filter(Boolean).join('; ') || null;
  } catch {
    return body.replace(/<[^>]+>/g, '').trim().slice(0, 200) || null;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
