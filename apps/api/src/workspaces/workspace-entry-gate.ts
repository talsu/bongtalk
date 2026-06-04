import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';

/**
 * S66 (D13 / FR-W05a): 워크스페이스 진입 2-게이트(순수 함수 — 단위 테스트 용이).
 *
 * (1) emailVerified=false → 403 EMAIL_NOT_VERIFIED (가입/초대 수락/도메인 가입 시점에
 *     재확인). (2) emailDomains 화이트리스트 exact-match — user.email 의 도메인부가
 *     화이트리스트(소문자 정규화)에 없으면 403 WORKSPACE_DOMAIN_NOT_ALLOWED.
 *
 * emailDomains 빈 배열(또는 undefined)이면 도메인 제한 없음(게이트 (2) 통과). 도메인
 * 비교는 user.email.split('@')[1] === domain(둘 다 소문자) 로 한다(PRD FR-W05 정의).
 * 화이트리스트는 생성/저장 시 이미 소문자 정규화되지만(WorkspacesService.create),
 * 방어적으로 비교 시에도 양변을 소문자화한다.
 */
export function assertWorkspaceEntryAllowed(input: {
  emailVerified: boolean;
  userEmail: string;
  emailDomains: string[];
}): void {
  if (!input.emailVerified) {
    throw new DomainError(
      ErrorCode.EMAIL_NOT_VERIFIED,
      '이메일 인증 후 워크스페이스에 참여할 수 있습니다',
    );
  }
  if (input.emailDomains.length === 0) return;
  const domain = input.userEmail.split('@')[1]?.toLowerCase() ?? '';
  const allowed = input.emailDomains.some((d) => d.trim().toLowerCase() === domain);
  if (!allowed) {
    throw new DomainError(
      ErrorCode.WORKSPACE_DOMAIN_NOT_ALLOWED,
      '이 워크스페이스는 허용된 이메일 도메인의 사용자만 참여할 수 있습니다',
    );
  }
}
