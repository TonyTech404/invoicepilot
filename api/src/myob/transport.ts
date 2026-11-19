// Connects the MYOB client to the in-process mock, and simulates the network failure
// that causes duplicate bills: MYOB saves the bill, but the response never arrives.
import { MOCK_BASE, FIRST_CREATE_HEADER, myobMock } from './mock.js';
import { MyobClient, type Transport } from './client.js';
import type { MyobMode } from '../../../shared/types.js';

/** How long the client waits for MYOB. Short, so the demo does not stall. */
export const CLIENT_TIMEOUT_MS = 2500;

export function mockTransport(mode: MyobMode): Transport {
  return async (req) => {
    const url = new URL(req.url);
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.text();
    const res = await myobMock.fetch(new Request(`http://mock${url.pathname}${url.search}`, { method: req.method, headers: req.headers, body }));

    // "Lost responses": the first time a bill is created, MYOB commits it and then the
    // connection drops. The client times out without knowing the bill exists.
    if (mode === 'lost_responses' && res.headers.get(FIRST_CREATE_HEADER)) {
      return new Promise<Response>(() => {}); // never resolves; the client's timeout fires
    }

    const headers = new Headers(res.headers);
    headers.delete(FIRST_CREATE_HEADER);
    return new Response(res.body, { status: res.status, headers });
  };
}

export function myobClientFor(workspace: { company_file_id: string; myob_mode: MyobMode }): MyobClient {
  return new MyobClient(mockTransport(workspace.myob_mode), {
    baseUrl: `${MOCK_BASE}/${workspace.company_file_id}`,
    accessToken: 'demo-access-token',
    apiKey: 'demo-api-key',
    timeoutMs: CLIENT_TIMEOUT_MS,
  });
}
