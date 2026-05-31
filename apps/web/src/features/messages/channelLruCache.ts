/**
 * S09 (FR-RT-22): 채널 메시지 목록 LRU 캐시 정책 — 순수 함수.
 *
 * React Query 의 gcTime 은 "마지막 사용 후 경과 시간" 기반이라 카운트 상한이
 * 없습니다. FR-RT-22 는 동시에 캐시 보관하는 **distinct 채널 수**를 상한
 * (CHANNEL_CACHE_SIZE)으로 제한하고, 초과 시 **가장 오래 전 진입한** 채널을
 * evict 하라고 명시합니다. 그 recency/eviction 판정만 이 파일에서 순수 함수로
 * 다루고, 실제 `qc.removeQueries` 호출은 훅(useChannelLru)이 담당합니다
 * (순수 로직과 React Query 부수효과 분리 → 단위 테스트 용이).
 *
 * recency 표현: 채널 키 배열을 "가장 오래됨 → 가장 최근" 순으로 유지합니다.
 * 배열 끝(tail)이 most-recently-entered, 앞(head)이 least-recently-entered.
 */

/**
 * 채널 진입(전환)을 LRU 순서에 반영합니다.
 *
 * - 이미 있던 채널이면 제거 후 tail 로 재배치(recency 갱신).
 * - 없던 채널이면 tail 에 추가.
 * - 결과 길이가 `maxSize` 를 초과하면 head(가장 오래됨)부터 잘라냅니다.
 *
 * 반환값: `{ order, evicted }`
 *   - `order`: 갱신된 LRU 순서(가장 오래됨 → 가장 최근).
 *   - `evicted`: 이번 진입으로 캐시에서 밀려난 채널 키 목록(evict 대상).
 *     호출부는 이 목록의 각 채널에 대해 `qc.removeQueries` 를 수행합니다.
 *
 * @param order   기존 LRU 순서(불변; 새 배열을 반환).
 * @param entered 이번에 진입(전환)한 채널 키.
 * @param maxSize 동시 보관 채널 상한(>=1). 1 미만 값은 1 로 보정합니다.
 */
export function touchChannel(
  order: readonly string[],
  entered: string,
  maxSize: number,
): { order: string[]; evicted: string[] } {
  const cap = Math.max(1, Math.floor(maxSize));
  // 기존 항목 제거 후 tail 에 재배치 → 진입 채널은 항상 most-recent.
  const withoutEntered = order.filter((k) => k !== entered);
  const next = [...withoutEntered, entered];
  if (next.length <= cap) {
    return { order: next, evicted: [] };
  }
  // 초과분은 head(가장 오래됨)부터 evict. 방금 진입한 채널은 tail 이라
  // 절대 evict 대상이 되지 않습니다.
  const overflow = next.length - cap;
  const evicted = next.slice(0, overflow);
  const kept = next.slice(overflow);
  return { order: kept, evicted };
}
