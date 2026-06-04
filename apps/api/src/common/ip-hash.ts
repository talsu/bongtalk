import { createHash } from 'node:crypto';
import ipaddr from 'ipaddr.js';

/**
 * S72 (D13 / FR-W22): IP soft-block 공유 헬퍼.
 *
 * 가입/초대 수락 진입점에서 요청 IP 를 sha256 해시로 저장/대조한다. 원시 IP 를 DB 에
 * 평문으로 남기지 않기 위해(개인정보 최소화 · BannedMember.ipHash / AuditLog.ipHash 는
 * 해시만 보관) 단방향 해시를 쓴다. 매칭은 동일 정규화 + 동일 해시 비교로만 이뤄진다.
 *
 * 정규화 규칙(매칭 안정성):
 *   - trim 후 소문자화.
 *   - IPv6 zone-id(`%eth0` 등 scope)는 제거한다 — 같은 클라이언트가 인터페이스 표기
 *     차이로 다른 zone 을 달고 와도 동일 주소로 본다.
 *   - 유효한 IP 는 ipaddr.js 로 canonical 표기로 정규화한다(security MEDIUM #1 / reviewer
 *     MINOR-2): IPv6 비압축(`2001:db8:0:0:0:0:0:1`)과 압축(`2001:db8::1`)이 같은 해시를
 *     갖게 RFC 5952 압축형으로 환원하고, IPv4-mapped IPv6(`::ffff:1.2.3.4`)는 내장
 *     IPv4(`1.2.3.4`)로 환원한다(듀얼스택 경로 차이 흡수). ipaddr.process()가
 *     IPv4-mapped 환원을 담당한다.
 *   - 파싱 불가(무효 입력)면 정규화 없이 trim+소문자 폴백을 그대로 쓴다(기존 동작 유지 —
 *     매칭은 동일 폴백 표기끼리만 성립).
 *
 * 주의: IP 는 NAT/모바일 캐리어 공유로 다수 사용자가 동일 주소를 쓸 수 있다. 그래서
 * IP 매칭은 hard-block 이 아니라 soft signal 로만 쓴다(FR-W22 — userId ban 만 hard).
 */

/**
 * trim + 소문자화 + IPv6 zone-id 제거 후, 유효 IP 면 ipaddr.js canonical 표기로 환원한다.
 * 무효 입력은 폴백(trim+소문자)을 그대로 돌려준다.
 */
export function normalizeIp(ip: string): string {
  // zone-id(scope) 제거: `fe80::1%eth0` → `fe80::1`. canonical 비교의 안정성을 위해
  // trim/소문자보다 먼저 떼어 낸다(zone 표기 차이를 같은 주소로 흡수).
  const fallback = ip
    .trim()
    .toLowerCase()
    .replace(/%[^%]*$/, '');
  try {
    // process()는 IPv4-mapped IPv6(::ffff:1.2.3.4)를 IPv4 로 환원하고, 그 외 IPv6 는
    // RFC 5952 압축형으로 canonical 화한다(toString()이 압축 표기). 무효면 throw → 폴백.
    return ipaddr.process(fallback).toString();
  } catch {
    return fallback;
  }
}

/**
 * 정규화한 IP 의 sha256 hex(64자). BannedMember.ipHash / WorkspaceMember.ipHash /
 * AuditLog.ipHash(모두 Char(64)) 에 그대로 저장한다. 빈/공백 입력은 매칭 불가를 의미하는
 * null 을 돌려준다(미상 IP 를 단일 해시로 묶어 오탐을 만들지 않기 위해).
 */
export function hashIp(ip: string | undefined | null): string | null {
  if (typeof ip !== 'string') return null;
  const normalized = normalizeIp(ip);
  if (normalized.length === 0 || normalized === 'unknown') return null;
  return createHash('sha256').update(normalized).digest('hex');
}
