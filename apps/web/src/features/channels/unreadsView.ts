import type { UnreadChannelSummary } from './useUnread';

/**
 * S24 (FR-RS-10): Unreads View 정렬 + 커서 페이지네이션의 순수 로직(단일 출처,
 * 테스트 대상). 서버 summarize 결과(채널별 unread/mention/lastMessageAt)를 받아:
 *
 *  1. unread 가 있는 채널만 남긴다(미읽 0 채널은 뷰에서 제외).
 *  2. **mentionCount 있는 채널 우선 → 최신 활동(lastMessageAt)순** 정렬.
 *     - 1차: mentionCount > 0 인 채널이 위(멘션 있는 채널 우선).
 *     - 2차: lastMessageAt 내림차순(최신 활동 먼저). null 은 가장 뒤.
 *     - 3차: channelId 사전순(안정 정렬 — 동률 시 결정적).
 *  3. 커서(이미 그려진 개수 offset)로 limit 만큼 slice → nextCursor 산출.
 *
 * 커서는 정렬 후 인덱스 기반(opaque offset)으로 둔다 — summary 가 클라 캐시에
 * 통째로 들어오므로 서버 라운드트립 없이 "더 보기" 가 가능하다(FR-RS-10 데스크톱
 * 우선). lastMessageAt 동률/null 케이스도 결정적이라 페이지 경계가 흔들리지 않는다.
 */

export interface UnreadsViewRow {
  channelId: string;
  unreadCount: number;
  mentionCount: number;
  hasMention: boolean;
  lastMessageAt: string | null;
}

export function sortUnreadsView(channels: UnreadChannelSummary[]): UnreadsViewRow[] {
  return channels
    .filter((c) => c.unreadCount > 0)
    .map((c) => ({
      channelId: c.channelId,
      unreadCount: c.unreadCount,
      mentionCount: c.mentionCount,
      hasMention: c.hasMention || c.mentionCount > 0,
      lastMessageAt: c.lastMessageAt,
    }))
    .sort((a, b) => {
      // 1차: 멘션 있는 채널 우선.
      const am = a.mentionCount > 0 ? 1 : 0;
      const bm = b.mentionCount > 0 ? 1 : 0;
      if (am !== bm) return bm - am;
      // 2차: 최신 활동순(내림차순). null lastMessageAt 은 뒤로.
      const at = a.lastMessageAt ? Date.parse(a.lastMessageAt) : -Infinity;
      const bt = b.lastMessageAt ? Date.parse(b.lastMessageAt) : -Infinity;
      if (at !== bt) return bt - at;
      // 3차: 결정적 안정 정렬.
      return a.channelId < b.channelId ? -1 : a.channelId > b.channelId ? 1 : 0;
    });
}

export interface UnreadsPage {
  rows: UnreadsViewRow[];
  /** 다음 페이지 시작 offset. 더 없으면 null. */
  nextCursor: number | null;
}

/**
 * 정렬된 전체 목록에서 cursor(offset)부터 limit 만큼 잘라 페이지를 만든다.
 * cursor 누적은 호출부(UnreadsView)가 "더 보기" 시 nextCursor 를 다시 넘기는 식.
 */
export function paginateUnreads(
  sorted: UnreadsViewRow[],
  cursor: number,
  limit: number,
): UnreadsPage {
  const start = Math.max(0, cursor);
  const end = start + limit;
  const rows = sorted.slice(0, end); // 누적 렌더(이전 페이지 포함).
  const nextCursor = end < sorted.length ? end : null;
  return { rows, nextCursor };
}
