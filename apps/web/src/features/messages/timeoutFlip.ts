import type { InfiniteData } from '@tanstack/react-query';
import type { ListMessagesResponse } from '@qufox/shared-types';
import { markOptimisticFailed, type OptimisticMessage, type SendState } from './sendState';

type Cache = InfiniteData<ListMessagesResponse>;

/**
 * S09 (FR-RT-05): 전송 타임아웃 발화 시 낙관 행을 'failed' 로 flip 하되,
 * **이미 confirmed(서버 행으로 교체) 또는 failed 인 경우 no-op** 으로 둡니다.
 *
 * 이중 flip 방지 규칙(plan):
 *   - 행이 캐시에서 사라졌으면(=onSuccess/WS echo 가 confirmOptimistic 으로
 *     실서버 id 로 교체) confirmed 로 간주 → no-op.
 *   - 행이 남아있어도 sendState 가 'pending' 이 아니면(이미 'failed') no-op.
 *   - 위 둘 다 아니면(여전히 pending) markOptimisticFailed 로 flip.
 *
 * `setQueryData` 의 updater 로 그대로 쓸 수 있도록 (old) => Cache 형태를
 * 반환하는 게 아니라, 캐시 스냅샷을 받아 다음 캐시를 돌려주는 순수 함수로
 * 둡니다(단위 테스트 용이). 호출부(useSendMessage 타이머 콜백)는
 * `qc.setQueryData(key, (old) => applyTimeoutFailure(old, optimisticId))` 로
 * 배선합니다.
 */
export function applyTimeoutFailure(
  old: Cache | undefined,
  optimisticId: string,
): Cache | undefined {
  if (!old) return old;
  // 캐시에서 해당 낙관 행을 찾는다. 못 찾으면(confirmed 로 교체됨) no-op.
  let row: OptimisticMessage | undefined;
  for (const p of old.pages) {
    const found = (p.items as OptimisticMessage[]).find((m) => m.id === optimisticId);
    if (found) {
      row = found;
      break;
    }
  }
  if (!row) return old; // confirmed (또는 애초에 없음) → no-op
  const state: SendState | undefined = row.sendState;
  if (state !== 'pending') return old; // 이미 failed → no-op
  return markOptimisticFailed(old, optimisticId) ?? old;
}
