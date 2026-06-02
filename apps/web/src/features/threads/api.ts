import { apiRequest } from '../../lib/api';
import type { ListThreadRepliesResponse } from '@qufox/shared-types';

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
 * 미읽과 독립). 204 (본문 없음). 퇴행 ack 는 서버가 no-op 처리하므로 클라가
 * 디바운스를 빠뜨려도 안전하다.
 */
export function ackThread(messageId: string, lastReadMessageId: string): Promise<void> {
  return apiRequest(`/messages/${messageId}/thread/ack`, {
    method: 'POST',
    body: { lastReadMessageId },
  });
}
