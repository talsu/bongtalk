import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * S84a (D16 / FR-RC11) — 인커밍 웹훅 토큰 crypto.
 *
 * 토큰 평문은 생성/회전 응답에서 1회만 노출되고 DB 에는 sha256(rawToken) 의 64-hex
 * 만 저장한다(bcrypt 미사용 — FR-RC11 명시). 검증은 timingSafeEqual 로 타이밍 사이드
 * 채널을 막는다. 평문은 절대 로깅/저장하지 않는다.
 */

/** `whk_` 접두 + 32바이트 난수(base64url). 충돌 확률 무시 가능(256-bit). */
const TOKEN_PREFIX = 'whk_';
const TOKEN_BYTES = 32;

export function generateRawToken(): string {
  return TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString('base64url');
}

/** sha256(rawToken) 의 소문자 64-hex. DB tokenHash 저장 정본. */
export function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

/**
 * 입력 평문 토큰이 저장된 64-hex 해시와 일치하는지 상수시간 비교한다.
 * - storedHashHex 가 64-hex 형식이 아니면 즉시 false(손상/레거시 방어).
 * - 두 Buffer 길이가 같을 때만 timingSafeEqual(길이 불일치 시 예외 회피).
 */
export function safeTokenEquals(rawToken: string, storedHashHex: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(storedHashHex)) return false;
  const incoming = Buffer.from(hashToken(rawToken), 'hex');
  const stored = Buffer.from(storedHashHex, 'hex');
  if (incoming.length !== stored.length) return false;
  return timingSafeEqual(incoming, stored);
}
