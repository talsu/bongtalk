import { describe, it, expect } from 'vitest';
import { isPrivateIPv4, isPrivateIPv6, ssrfGuard } from '../../../src/links/ssrf-guard';

/**
 * task-045 iter2: SSRF guard 단위 검증.
 * DNS lookup 의존 case 는 stable hostname (example.com) 만 사용.
 */

describe('isPrivateIPv4', () => {
  it.each([
    ['127.0.0.1', true],
    ['127.255.255.255', true],
    ['10.0.0.1', true],
    ['172.16.5.5', true],
    ['172.31.255.255', true],
    ['192.168.1.1', true],
    ['169.254.169.254', true], // AWS metadata
    ['100.64.0.1', true], // CGNAT
    ['0.0.0.0', true],
    ['224.0.0.1', true], // multicast
    ['8.8.8.8', false],
    ['1.1.1.1', false],
    ['172.32.0.1', false], // 172.32 은 사설 아님
    ['172.15.0.1', false],
    ['11.0.0.1', false],
  ])('IPv4 %s → private=%s', (ip, expected) => {
    expect(isPrivateIPv4(ip)).toBe(expected);
  });

  it('잘못된 형식은 보수적으로 차단', () => {
    expect(isPrivateIPv4('not-an-ip')).toBe(true);
    expect(isPrivateIPv4('999.999.999.999')).toBe(true);
  });
});

describe('isPrivateIPv6', () => {
  it.each([
    ['::1', true],
    ['fc00::1', true],
    ['fd12:3456::1', true],
    ['fe80::1', true],
    ['ff00::1', true], // multicast
    ['::ffff:127.0.0.1', true], // mapped IPv4 사설
    ['2001:4860:4860::8888', false], // Google DNS
    ['2606:4700:4700::1111', false], // Cloudflare DNS
    ['::ffff:8.8.8.8', false], // mapped IPv4 public
  ])('IPv6 %s → private=%s', (ip, expected) => {
    expect(isPrivateIPv6(ip)).toBe(expected);
  });
});

describe('ssrfGuard', () => {
  it('file:// scheme 차단', async () => {
    const r = await ssrfGuard('file:///etc/passwd');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unsupported_scheme');
  });

  it('gopher:// scheme 차단', async () => {
    const r = await ssrfGuard('gopher://localhost:11211/');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unsupported_scheme');
  });

  it('userinfo 포함 URL 차단', async () => {
    const r = await ssrfGuard('http://attacker@evil.com/');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('userinfo_present');
  });

  it('IP literal 사설 IPv4 차단', async () => {
    const r = await ssrfGuard('http://10.0.0.1/admin');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('private_ip');
  });

  it('IP literal 169.254.169.254 (AWS metadata) 차단', async () => {
    const r = await ssrfGuard('http://169.254.169.254/latest/meta-data/');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('private_ip');
  });

  it('IP literal localhost (127.0.0.1) 차단', async () => {
    const r = await ssrfGuard('http://127.0.0.1:6379/');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('private_ip');
  });

  it('IP literal IPv6 ::1 차단', async () => {
    const r = await ssrfGuard('http://[::1]/admin');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('private_ip');
  });

  it('잘못된 URL 형식 차단', async () => {
    const r = await ssrfGuard('not a url');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid_url');
  });

  it('public domain (example.com) 통과', async () => {
    // example.com 은 RFC 2606 reserved, 공인 IP 만 응답.
    const r = await ssrfGuard('https://example.com/');
    if (r.ok === false) {
      // CI 환경에서 DNS 실패 가능성 — 'private_ip' 가 아닌
      // 'dns_resolution_failed' 만 허용.
      expect(r.reason).toBe('dns_resolution_failed');
      return;
    }
    expect(r.url.hostname).toBe('example.com');
    expect(typeof r.resolvedIp).toBe('string');
    expect(['4', '6']).toContain(String(r.family));
  });
});
