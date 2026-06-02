import type { ActivityRow } from './useActivity';

/**
 * S47 (FR-MN-13): Activity Inbox 항목 클릭 동작 결정(순수 함수).
 *
 * 클릭 fallback(PRD 정본):
 *   ① 채널 삭제(채널을 캐시/목록에서 못 찾음) → toast "채널을 찾을 수 없습니다" + 패널 유지.
 *   ② 권한 회수(채널은 있으나 접근 불가) → toast "접근 권한이 없습니다" + 패널 유지.
 *   ③ 스레드 답글(kind='reply') → 채널 이동 + Thread Panel 오픈 + 스크롤 + 2초 하이라이트.
 *   ④ 그 외(멘션/반응/DM) → 채널 이동 + 메시지 점프.
 * friend_request 는 채널이 없으므로(workspaceId/channelId 빈값) 'noop'(프로필/요청 화면은
 * 본 슬라이스 범위 밖 — 패널 유지).
 *
 * channel 조회 결과(`channel`)는 호출부가 채널 목록 캐시에서 해석해 넘긴다:
 *   - undefined  → 채널 부재(삭제) → 'channel-not-found'
 *   - { accessible:false } → 권한 회수 → 'no-access'
 *   - { accessible:true } → 정상 라우팅.
 */
export interface ActivityClickChannel {
  accessible: boolean;
}

export type ActivityClickAction =
  | { type: 'channel-not-found' }
  | { type: 'no-access' }
  | { type: 'thread-jump'; channelId: string; messageId: string; workspaceId: string }
  | { type: 'message-jump'; channelId: string; messageId: string; workspaceId: string }
  | { type: 'noop' };

export function resolveActivityClick(
  row: ActivityRow,
  channel: ActivityClickChannel | undefined,
): ActivityClickAction {
  // 친구 요청 등 채널 컨텍스트가 없는 항목은 점프 대상이 없다.
  if (row.kind === 'friend_request' || !row.channelId || !row.workspaceId) {
    return { type: 'noop' };
  }
  if (channel === undefined) {
    return { type: 'channel-not-found' };
  }
  if (!channel.accessible) {
    return { type: 'no-access' };
  }
  if (row.kind === 'reply') {
    return {
      type: 'thread-jump',
      channelId: row.channelId,
      messageId: row.messageId,
      workspaceId: row.workspaceId,
    };
  }
  return {
    type: 'message-jump',
    channelId: row.channelId,
    messageId: row.messageId,
    workspaceId: row.workspaceId,
  };
}

/** 클릭 fallback 토스트 문구(PRD 정본). */
export const ACTIVITY_TOAST = {
  channelNotFound: '채널을 찾을 수 없습니다',
  noAccess: '접근 권한이 없습니다',
} as const;
