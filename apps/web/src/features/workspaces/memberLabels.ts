/**
 * S69 fix-forward (a11y N-01): 디렉터리/프로필이 공유하는 역할·상태 한글 라벨 매핑.
 * 종전엔 MemberProfilePanel 에만 ROLE_LABEL 이 있고 디렉터리 행은 영문 enum(MEMBER 등)
 * 을 그대로 노출했다. 두 컴포넌트가 같은 매핑을 쓰도록 util 로 추출한다.
 */
export const ROLE_LABEL: Record<string, string> = {
  OWNER: '소유자',
  ADMIN: '관리자',
  MODERATOR: '모더레이터',
  MEMBER: '멤버',
  GUEST: '게스트',
};

export const STATUS_LABEL: Record<string, string> = {
  online: '온라인',
  idle: '자리 비움',
  dnd: '다른 용무 중',
  offline: '오프라인',
};
