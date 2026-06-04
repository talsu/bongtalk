import { createHash } from 'node:crypto';

/**
 * S72 (D13 / FR-W22): IP soft-block 공유 헬퍼.
 *
 * 가입/초대 수락 진입점에서 요청 IP 를 sha256 해시로 저장/대조한다. 원시 IP 를 DB 에
 * 평문으로 남기지 않기 위해(개인정보 최소화 · BannedMember.ipHash / AuditLog.ipHash 는
 * 해시만 보관) 단방향 해시를 쓴다. 매칭은 동일 정규화 + 동일 해시 비교로만 이뤄진다.
 *
 * 정규화 규칙(매칭 안정성):
 *   - trim 후 소문자화.
 *   - IPv4-mapped IPv6(`::ffff:1.2.3.4`)는 내장 IPv4(`1.2.3.4`)로 환원한다 — 동일
 *     클라이언트가 듀얼스택 경로 차이로 다른 표기로 도달해도 같은 해시를 갖게 한다.
 *
 * 주의: IP 는 NAT/모바일 캐리어 공유로 다수 사용자가 동일 주소를 쓸 수 있다. 그래서
 * IP 매칭은 hard-block 이 아니라 soft signal 로만 쓴다(FR-W22 — userId ban 만 hard).
 */

/** IPv4-mapped IPv6 접두사(`::ffff:`)를 제거하고 trim + 소문자화한다. */
export function normalizeIp(ip: string): string {
  const trimmed = ip.trim().toLowerCase();
  // `::ffff:1.2.3.4` 형태(IPv4-mapped IPv6)는 내장 IPv4 로 환원한다.
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(trimmed);
  if (mapped) {
    return mapped[1];
  }
  return trimmed;
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
