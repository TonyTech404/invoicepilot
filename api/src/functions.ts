// Azure Functions entry point. One HTTP function forwards every /api/* request to the Hono app.
import { app as functions, type HttpRequest, type HttpResponseInit } from '@azure/functions';
import { app } from './app.js';

functions.http('api', {
  route: '{*path}',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  authLevel: 'anonymous',
  handler: async (req: HttpRequest): Promise<HttpResponseInit> => {
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer();
    const res = await app.fetch(new Request(req.url, { method: req.method, headers: req.headers as unknown as Headers, body }));

    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      if (key !== 'set-cookie') headers[key] = value;
    });
    const cookies = res.headers.getSetCookie();
    return {
      status: res.status,
      headers,
      cookies: cookies.map(parseCookie),
      body: new Uint8Array(await res.arrayBuffer()),
    };
  },
});

// Functions wants cookies as objects rather than raw Set-Cookie strings.
function parseCookie(raw: string) {
  const [pair, ...attrs] = raw.split(';').map((s) => s.trim());
  const eq = pair.indexOf('=');
  const cookie: Record<string, unknown> = { name: pair.slice(0, eq), value: decodeURIComponent(pair.slice(eq + 1)) };
  for (const attr of attrs) {
    const [k, v] = attr.split('=');
    switch (k.toLowerCase()) {
      case 'path': cookie.path = v; break;
      case 'max-age': cookie.maxAge = Number(v); break;
      case 'expires': cookie.expires = new Date(v); break;
      case 'httponly': cookie.httpOnly = true; break;
      case 'secure': cookie.secure = true; break;
      case 'samesite': cookie.sameSite = v as 'Lax'; break;
    }
  }
  return cookie as never;
}
