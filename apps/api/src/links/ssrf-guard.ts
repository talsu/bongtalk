import { promises as dns } from 'node:dns';
import { isIPv4, isIPv6 } from 'node:net';

/**
 * task-045 iter2: SSRF (Server-Side Request Forgery) 차단 가드.
 *
 * Link unfurl 의 URL fetch 가 내부망으로 향하지 않도록 검증합니다.
 * **차단 대상**:
 *  - `http(s)` 가 아닌 scheme (file://, gopher://, ftp:// 등)
 *  - userinfo 포함 URL (`http://attacker@host`) — DNS rebind + 인증 우회
 *  - localhost / 127.x / ::1
 *  - 사설 IPv4: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16
 *  - 사설/local IPv6: fc00::/7 (ULA), fe80::/10 (link-local), ::1
 *  - DNS 결과의 모든 IP 검증 (다중 A 레코드 → 하나라도 사설이면 reject)
 *
 * **검증 후**: 통과한 첫 번째 IP 를 반환 — 호출자는 fetch 시 host
 * 헤더 = 원래 도메인, 실제 connect = 검증된 IP 가 되도록 강제하면
 * DNS rebinding 공격을 차단할 수 있습니다.
 *
 * 메모리: NAS-only 배포라 CGNAT (100.64.0.0/10) 도 차단 권장 — public
 * 인터넷 OG 만 허용.
 */

export type SsrfGuardResult =
  | { ok: true; resolvedIp: string; family: 4 | 6; url: URL }
  | { ok: false; reason: SsrfRejectReason };

export type SsrfRejectReason =
  | 'invalid_url'
  | 'unsupported_scheme'
  | 'userinfo_present'
  | 'private_ip'
  | 'dns_resolution_failed';

const PRIVATE_IPV4_RANGES: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved
];

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return -1;
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

export function isPrivateIPv4(ip: string): boolean {
  const intIp = ipv4ToInt(ip);
  if (intIp < 0) return true; // 잘못된 형식이면 보수적으로 차단
  for (const [base, prefix] of PRIVATE_IPV4_RANGES) {
    const baseInt = ipv4ToInt(base);
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    if ((intIp & mask) === (baseInt & mask)) return true;
  }
  return false;
}

export function isPrivateIPv6(ip: string): boolean {
  // IPv4-mapped (::ffff:1.2.3.4) → 추출 후 IPv4 검증.
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return isPrivateIPv4(mapped[1]);
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  // fc00::/7 (ULA): first byte 0xfc or 0xfd.
  // fe80::/10 (link-local): first 10 bits 1111 1110 10.
  // ff00::/8 (multicast).
  // Use byte-prefix check on the expanded form.
  // Expand ::-shorthand minimally: split → groups, fill ::.
  const groups = expandIPv6(lower);
  if (groups === null) return true; // malformed → 보수적 차단
  const firstByte = (groups[0] >> 8) & 0xff;
  if (firstByte === 0xfc || firstByte === 0xfd) return true; // ULA
  if (firstByte === 0xfe && (groups[0] & 0x00c0) === 0x0080) return true; // fe80::/10
  if (firstByte === 0xff) return true; // multicast
  return false;
}

function expandIPv6(ip: string): number[] | null {
  if (!isIPv6(ip)) return null;
  // ioredis 등에서 받은 IPv6 형식. 표준 라이브러리 없이 expand.
  let head: string[] = [];
  let tail: string[] = [];
  if (ip.includes('::')) {
    const [h, t] = ip.split('::');
    head = h ? h.split(':') : [];
    tail = t ? t.split(':') : [];
  } else {
    head = ip.split(':');
  }
  const fillCount = 8 - head.length - tail.length;
  if (fillCount < 0) return null;
  const groups = [...head, ...new Array(fillCount).fill('0'), ...tail].map((g) => parseInt(g, 16));
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) {
    return null;
  }
  return groups;
}

/**
 * URL 한 개를 검증해 fetch 안전 여부를 판정합니다. 호출자는 ok=true
 * 시 url + resolvedIp 를 받아 실제 fetch 에 사용합니다.
 */
export async function ssrfGuard(rawUrl: string): Promise<SsrfGuardResult> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'unsupported_scheme' };
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, reason: 'userinfo_present' };
  }
  // URL parser 가 IPv6 literal 을 [..] 로 감싸 반환할 수 있어 brackets
  // 제거. Node 20 의 URL.hostname 동작.
  const rawHost = parsed.hostname;
  const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;
  // Host 가 IP literal 인 경우 직접 검증.
  if (isIPv4(host)) {
    if (isPrivateIPv4(host)) return { ok: false, reason: 'private_ip' };
    return { ok: true, resolvedIp: host, family: 4, url: parsed };
  }
  if (isIPv6(host)) {
    if (isPrivateIPv6(host)) return { ok: false, reason: 'private_ip' };
    return { ok: true, resolvedIp: host, family: 6, url: parsed };
  }
  // 도메인 → DNS lookup. 모든 결과 검증.
  let addrs: { address: string; family: number }[];
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    return { ok: false, reason: 'dns_resolution_failed' };
  }
  if (addrs.length === 0) {
    return { ok: false, reason: 'dns_resolution_failed' };
  }
  for (const a of addrs) {
    const isPrivate = a.family === 4 ? isPrivateIPv4(a.address) : isPrivateIPv6(a.address);
    if (isPrivate) {
      return { ok: false, reason: 'private_ip' };
    }
  }
  // 모두 public — 첫 번째 IP 를 사용 (DNS rebinding 차단을 위한 IP-pinning).
  const first = addrs[0];
  return {
    ok: true,
    resolvedIp: first.address,
    family: first.family === 6 ? 6 : 4,
    url: parsed,
  };
}
