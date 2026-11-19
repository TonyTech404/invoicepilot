import { timingSafeEqual } from 'node:crypto';

/**
 * The visitor's IP, for rate limits.
 *
 * Requests through the Cloudflare Worker on the custom domain all reach Azure from Cloudflare,
 * so the Worker forwards the real address in x-visitor-ip, vouched for by a shared key.
 * Without the right key that header is ignored, so nobody can pick their own IP.
 */
export function clientIp(header: (name: string) => string | undefined, proxyKey: string): string {
  const given = Buffer.from(header('x-proxy-key') ?? '');
  const expected = Buffer.from(proxyKey);
  const visitor = header('x-visitor-ip');
  if (expected.length && visitor && given.length === expected.length && timingSafeEqual(given, expected)) return visitor;
  return (header('x-forwarded-for') ?? header('x-client-ip') ?? 'local').split(',')[0].trim().replace(/:\d+$/, '');
}
