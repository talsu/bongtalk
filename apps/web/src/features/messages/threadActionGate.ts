import type { MessageDto, ThreadSummary } from '@qufox/shared-types';

/**
 * S33 (FR-TH-01): 'Reply in thread' 액션 게이트.
 *
 * PRD FR-TH-01: "채널의 모든 루트 메시지에 대해 'Reply in thread' 액션을
 * 제공해야 한다. parentMessageId를 가진 메시지(답글)는 스레드 시작 불가."
 *
 * 게이트 조건:
 *   - onOpenThread 핸들러가 부모로부터 전달되어야 한다(채널 컨텍스트에서만).
 *   - 낙관적(tmp-) 행은 아직 서버 id 가 없어 스레드를 열 수 없다.
 *   - 답글(parentMessageId != null)은 스레드를 호스트하지 못한다 — 루트만.
 *   - S33 fix-forward (MAJOR-2): 삭제된(deleted) 메시지는 스레드를 시작할 수
 *     없다 — GET /thread 는 deletedAt:null 루트만 200 을 돌려주므로 삭제
 *     placeholder 에서 스레드를 열면 404 가 된다.
 *
 * 순수 함수로 분리해 컴포넌트/DS 변경과 무관하게 게이트 규칙을 단위 검증한다.
 */
export function canStartThread(
  msg: Pick<MessageDto, 'id' | 'parentMessageId' | 'deleted'>,
  hasOpenThreadHandler: boolean,
): boolean {
  if (!hasOpenThreadHandler) return false;
  if (msg.id.startsWith('tmp-')) return false;
  if (msg.parentMessageId) return false;
  // S33 fix-forward (MAJOR-2): 삭제된 메시지의 placeholder 에서는 스레드를
  // 새로 시작할 수 없다(루트가 deletedAt 이라 서버가 404).
  if (msg.deleted) return false;
  return true;
}

/**
 * S33 fix-forward (MAJOR-2 + NIT-2): 'N개 답글 보기' thread chip 의 가시성
 * 게이트.
 *
 * chip 은 답글이 1개 이상인 루트에만 노출되며, 클릭 시 GET /thread 로 스레드를
 * 연다. 그러나 그 엔드포인트는 deletedAt:null 인 루트만 200 을 돌려주므로,
 * 삭제된(deleted) thread-root placeholder 에 chip 을 노출하면 클릭 시 404 가
 * 난다. 따라서 chip 가시 조건에서 deleted 루트를 제외한다.
 *
 * canStartThread 와 동일하게 순수 함수로 분리해 단위 검증한다.
 */
export function threadChipVisible(
  msg: Pick<MessageDto, 'deleted'>,
  thread: ThreadSummary | null | undefined,
  hasOpenThreadHandler: boolean,
): boolean {
  if (!hasOpenThreadHandler) return false;
  if (!thread || thread.replyCount <= 0) return false;
  // 삭제된 루트 placeholder 에서는 chip 클릭 → GET /thread 404 이므로 숨긴다.
  if (msg.deleted) return false;
  return true;
}
