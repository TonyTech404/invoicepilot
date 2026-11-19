import { describe, expect, it } from 'vitest';
import { clientIp } from '../src/lib/ip.js';

const headers = (h: Record<string, string>) => (name: string) => h[name];

describe('clientIp', () => {
  it('uses the first x-forwarded-for address, without its port', () => {
    expect(clientIp(headers({ 'x-forwarded-for': '203.0.113.7:51234, 10.0.0.1' }), 'k')).toBe('203.0.113.7');
  });

  it('trusts the visitor IP from the Worker when the key matches', () => {
    expect(clientIp(headers({ 'x-forwarded-for': '172.70.1.1', 'x-visitor-ip': '203.0.113.7', 'x-proxy-key': 'secret' }), 'secret')).toBe('203.0.113.7');
  });

  it('ignores a forged visitor IP', () => {
    expect(clientIp(headers({ 'x-forwarded-for': '198.51.100.2', 'x-visitor-ip': '1.2.3.4', 'x-proxy-key': 'guess' }), 'secret')).toBe('198.51.100.2');
    expect(clientIp(headers({ 'x-forwarded-for': '198.51.100.2', 'x-visitor-ip': '1.2.3.4', 'x-proxy-key': '' }), '')).toBe('198.51.100.2');
  });
});
