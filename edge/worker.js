// Serves invoicepilot.buildwithanthony.com by forwarding to the Azure Static Web App.
//
// The domain's DNS lives on Cloudflare, so a Worker custom domain is the simplest way to put
// the app on it. Everything passes through unchanged except two headers: the visitor's real IP
// (Azure would otherwise see Cloudflare's), and a shared key that tells the API to trust it.
const ORIGIN = 'https://ashy-tree-0d409aa00.4.azurestaticapps.net';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const target = new URL(url.pathname + url.search, ORIGIN);

    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.set('x-visitor-ip', request.headers.get('cf-connecting-ip') ?? '');
    headers.set('x-proxy-key', env.PROXY_KEY ?? '');

    const res = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      redirect: 'manual',
    });

    // Keep redirects on the custom domain.
    const out = new Response(res.body, res);
    const location = out.headers.get('location');
    if (location?.startsWith(ORIGIN)) out.headers.set('location', url.origin + location.slice(ORIGIN.length));
    return out;
  },
};
