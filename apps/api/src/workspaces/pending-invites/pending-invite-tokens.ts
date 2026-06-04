import { createHash, randomBytes } from 'node:crypto';
// S68 fix-forward (reviewer MN2 / security MEDIUM-2): 다중레이블 도메인 경고 판별을
// @qufox/shared-types 단일 출처로 끌어올렸다(FE EmailDomainsPanel 과 공유). 여기서는
// 동일 헬퍼를 재노출만 해 기존 import 경로(./pending-invite-tokens)를 무회귀로 유지한다.
export { isOverlyBroadDomain, TWO_LEVEL_PUBLIC_SUFFIXES } from '@qufox/shared-types';

/**
 * S68 (D13 / FR-W04·W04a): 이메일 초대 토큰 순수 헬퍼(부수효과 없음 — 단위 테스트 용이).
 *
 * 보안 불변식(★핵심 AC):
 *   - rawToken 은 crypto-secure 랜덤이며 이메일/링크에만 실린다.
 *   - DB 엔 sha256(rawToken) = tokenHash(64-hex) 만 저장한다(평문 금지).
 *   - 수락 시 sha256(rawToken) 을 재계산해 저장된 tokenHash 와 대조한다(평문 비교 금지).
 *   - opaque 코드(미가입 분기 ①)도 crypto-secure 랜덤이며 Redis 키로만 쓰인다(DB 행 불요).
 */

/** rawToken 1개를 발급한다(32바이트 base64url ≈ 256bit). 이메일에만 실린다. */
export function makeRawToken(): string {
  return randomBytes(32).toString('base64url');
}

/** 미가입 분기 ① opaque 코드(rawToken 을 가린 단기 교환 코드). DB 행 불필요. */
export function makeOpaqueCode(): string {
  return randomBytes(24).toString('base64url');
}

/** rawToken → sha256 64-hex. DB tokenHash 저장값 + 수락 대조에 동일하게 쓴다. */
export function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

/** 이메일 정규화(소문자 + 트림). 중복 판별·@@unique([workspaceId,email]) 대조에 쓴다. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * FR-W04a 수락 4분기 결정(순수 함수).
 *   ① UNREGISTERED — 이메일에 해당하는 가입 계정 없음 → opaque 교환 + 회원가입 리다이렉트.
 *   ② SELF_MATCH   — 로그인 사용자의 이메일이 초대 이메일과 일치 → 즉시 수락.
 *   ③ OTHER_ACCOUNT— 로그인 사용자가 있으나 이메일 불일치 → 계정 확인 다이얼로그.
 * (④ 만료/무효는 토큰 검증 단계에서 별도 처리하므로 이 분기 함수에 포함하지 않는다.)
 */
export type AcceptBranch = 'UNREGISTERED' | 'SELF_MATCH' | 'OTHER_ACCOUNT';

export function decideAcceptBranch(input: {
  inviteEmail: string;
  // 현재 로그인 사용자(없으면 익명 — 미가입 분기로 안내).
  currentUserEmail: string | null;
  // 초대 이메일에 매칭되는 가입 계정이 존재하는지.
  inviteEmailHasAccount: boolean;
}): AcceptBranch {
  const inviteEmail = normalizeEmail(input.inviteEmail);
  if (input.currentUserEmail !== null) {
    if (normalizeEmail(input.currentUserEmail) === inviteEmail) return 'SELF_MATCH';
    return 'OTHER_ACCOUNT';
  }
  // 비로그인: 초대 이메일에 계정이 있으면 로그인 유도(OTHER_ACCOUNT 와 동일 안내), 없으면 가입.
  return input.inviteEmailHasAccount ? 'OTHER_ACCOUNT' : 'UNREGISTERED';
}
