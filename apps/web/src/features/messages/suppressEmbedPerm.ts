/**
 * 072 백로그 S-F (FR-RC08 / N0-F4): 메시지 링크 임베드 억제(suppress) 버튼 노출 판정.
 *
 * 서버 게이트(messages.controller suppressEmbed)는 "작성자 본인 OR DELETE_ANY_MESSAGE
 * (채널 override fold 포함)"이다. 종전 FE 는 viewerRole(OWNER/ADMIN)만 봐서 채널 override
 * 를 무시했다(MEMBER override 보유자 false neg · OWNER/ADMIN deny override false pos).
 *
 * 이제 서버가 ListMessagesResponse.viewerPermissions.canManageMessages(= DELETE_ANY_MESSAGE)
 * 를 페이지당 1회 진실로 내려주므로, 그 값 + 작성자 비교로 정확히 분기한다(클라 권한 추정 제거).
 * 임베드는 워크스페이스 채널에서만 의미가 있고(DM 은 workspaceId 없음), 낙관적(tmp-) 행은
 * 아직 서버 임베드가 없어 제외한다. 순수 함수 — 단위 테스트 + MessageList 가 공유한다.
 */
export interface SuppressEmbedPermInput {
  /** 워크스페이스 채널 여부(DM 은 false). */
  hasWorkspace: boolean;
  /** 낙관적 임시 행(id 가 'tmp-' 로 시작)이면 true. */
  isTmpRow: boolean;
  /** 메시지 작성자가 본인인지. */
  isAuthor: boolean;
  /** 서버 진실: viewer 가 이 채널에서 MANAGE_MESSAGES(DELETE_ANY_MESSAGE) 보유. */
  canManageMessages: boolean;
}

export function deriveCanSuppressEmbed(input: SuppressEmbedPermInput): boolean {
  if (!input.hasWorkspace || input.isTmpRow) return false;
  return input.isAuthor || input.canManageMessages;
}
