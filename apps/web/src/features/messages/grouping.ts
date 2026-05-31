import { isSystemMessageType, type MessageDto } from '@qufox/shared-types';

/**
 * S04 (FR-MSG-10 / FR-MSG-19) — 메시지 그루핑 계산(클라이언트 전용).
 *
 * 서버는 grouped 필드를 내려주지 않으며, 클라이언트가 인접 메시지로부터
 * 계산합니다. 동일 작성자가 직전 메시지로부터 5분 이내 연속 작성하고 사이에
 * 다른 작성자/시스템 행이 없으면 grouped=true(아바타·헤더 숨김).
 *
 * SYSTEM_* 규칙(FR-MSG-19):
 *   - 시스템 메시지 자신은 항상 grouped=false(독립 행).
 *   - 시스템 메시지 *다음* 의 일반 메시지도 grouped=false(시스템 행이 작성자
 *     체인을 끊음 → ±1 인접 재계산).
 *
 * MessageList.tsx 의 인라인 분기와 동일 술어를 공유해 회귀를 막습니다.
 */
export const GROUPING_WINDOW_MS = 5 * 60_000;

/**
 * `index` 위치 메시지가 직전 메시지의 continuation(grouped=true)인지 판정합니다.
 * `prev` 가 없으면(첫 행) false. 본 함수는 순수 함수라 단위 테스트로 SYSTEM
 * 인접 재계산 AC 를 검증할 수 있습니다.
 */
export function isContinuation(curr: MessageDto, prev: MessageDto | null): boolean {
  if (isSystemMessageType(curr.type)) return false;
  if (!prev) return false;
  if (isSystemMessageType(prev.type)) return false;
  if (prev.deleted || curr.deleted) return false;
  if (prev.authorId !== curr.authorId) return false;
  if (prev.parentMessageId !== curr.parentMessageId) return false;
  return (
    new Date(curr.createdAt).getTime() - new Date(prev.createdAt).getTime() < GROUPING_WINDOW_MS
  );
}

/**
 * 전체 목록의 grouped 플래그를 한 번에 계산합니다. WS 삽입/삭제/배치 후
 * MessageList 가 재호출하며, 시스템 행 인접의 재계산도 자연히 반영됩니다.
 * 반환 배열의 i 번째 = messages[i] 의 grouped 여부.
 */
export function computeGrouping(messages: MessageDto[]): boolean[] {
  return messages.map((m, i) => isContinuation(m, i > 0 ? messages[i - 1] : null));
}
