import { apiRequest } from '../../lib/api';
import type {
  ListMyThreadsResponse,
  ListThreadRepliesResponse,
  SetThreadLockResponse,
  SetThreadNotificationLevelResponse,
  ThreadNotificationLevel,
} from '@qufox/shared-types';

/**
 * Task-014-B thread client. Same `/messages/:id/...` URL shape as
 * reactions — the message id is globally unique, channel + workspace
 * derived server-side.
 */
export function listThreadReplies(
  messageId: string,
  opts: { cursor?: string; limit?: number } = {},
): Promise<ListThreadRepliesResponse> {
  const qs: string[] = [];
  if (opts.cursor) qs.push(`cursor=${encodeURIComponent(opts.cursor)}`);
  if (typeof opts.limit === 'number') qs.push(`limit=${opts.limit}`);
  const query = qs.length ? `?${qs.join('&')}` : '';
  return apiRequest(`/messages/${messageId}/thread${query}`);
}

/**
 * S36 (FR-RS-12 / FR-TH-12): 스레드 읽음 ACK. 패널 mount + 최하단 스크롤 시
 * 호출해 ThreadReadState 를 마지막으로 본 답글까지 monotonic 전진시킨다(채널
 * 읽지 않음과 독립). 204 (본문 없음). 퇴행 ack 는 서버가 no-op 처리하므로 클라가
 * 디바운스를 빠뜨려도 안전하다.
 */
export function ackThread(messageId: string, lastReadMessageId: string): Promise<void> {
  return apiRequest(`/messages/${messageId}/thread/ack`, {
    method: 'POST',
    body: { lastReadMessageId },
  });
}

/**
 * S38 (FR-TH-08): 스레드 알림 레벨 설정(+ 수동 구독). ThreadPanel 헤더 벨
 * 드롭다운에서 ALL/MENTIONS/OFF 를 고르면 호출한다. 서버가 ThreadSubscription
 * 을 upsert(없으면 INSERT = 수동 구독)한다.
 */
export function setThreadNotificationLevel(
  parentMessageId: string,
  notificationLevel: ThreadNotificationLevel,
): Promise<SetThreadNotificationLevelResponse> {
  return apiRequest(`/users/me/threads/${parentMessageId}/subscription`, {
    method: 'PATCH',
    body: { notificationLevel },
  });
}

/**
 * S38 (FR-TH-09): 내 구독 스레드 목록(Threads 탭). 읽지 않음 우선, latestReplyAt DESC.
 */
export function listMyThreads(): Promise<ListMyThreadsResponse> {
  return apiRequest(`/users/me/threads`);
}

/**
 * S38 (FR-TH-10): 내 구독 스레드 전체 읽음 처리(각 스레드 최신 답글까지).
 */
export function markAllThreadsRead(): Promise<{ updated: number }> {
  return apiRequest(`/users/me/threads/read-all`, { method: 'POST' });
}

/**
 * S38 (FR-TH-13): 스레드 잠금/해제. OWNER/ADMIN 만(서버 게이트). 성공 시
 * thread:lock:changed 가 채널 룸으로 브로드캐스트된다.
 */
export function setThreadLock(messageId: string, locked: boolean): Promise<SetThreadLockResponse> {
  return apiRequest(`/messages/${messageId}/thread/lock`, {
    method: 'PATCH',
    body: { locked },
  });
}
