import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import type { ListMessagesResponse } from '@qufox/shared-types';
import { toggleReaction } from './api';
import { qk } from '../../lib/query-keys';
import { upsertReactionBucket } from '../realtime/dispatcher';
import { useNotifications } from '../../stores/notification-store';
import { friendlyError } from '../../lib/error-messages';

/**
 * S39 (FR-RE01): toggle 디바운스 윈도우(ms). 동일 messageId × 동일 이모지 조합의
 * 빠른 연속 클릭만 묶는다 — 다른 이모지는 독립 타이머라 즉시 반응한다.
 */
export const REACTION_DEBOUNCE_MS = 300;

type ToggleArgs = { messageId: string; emoji: string; currentlyByMe: boolean };

/**
 * S39 (FR-RE01): single-call toggle 리액션 훅. 동작 계약:
 *   1. 클릭 즉시 낙관적으로 캐시에 ±1 반영(즉각 UI 피드백).
 *   2. 동일 messageId × 동일 이모지 조합은 300ms 디바운스로 묶어 단일 POST 전송
 *      (서버 toggle 이라 짝수번 클릭은 결국 no-op — 마지막 의도만 보내면 충분).
 *      다른 이모지는 독립 타이머라 즉시 전송된다.
 *   3. reaction:updated WS 수신 시 dispatcher 가 해당 messageId 반응을 full
 *      replace 한다(WS 가 진실값 — GET 재조회 불필요).
 *   4. POST 실패(네트워크·409 등) 시 직전 캐시 스냅샷으로 롤백(GET 재조회 불필요).
 */
export function useToggleReaction(
  wsId: string | null,
  channelId: string,
): { toggle: (args: ToggleArgs) => void } {
  const qc = useQueryClient();
  const key = useMemo(() => qk.messages.list(wsId ?? 'global', channelId), [wsId, channelId]);

  // combo 키(`${messageId}::${emoji}`)별 디바운스 타이머. 같은 조합의 연속 클릭은
  // 직전 타이머를 취소하고 다시 건다(마지막 의도만 네트워크에 반영).
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  // 언마운트 시 보류 중인 타이머를 모두 정리(leak 방지).
  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const t of map.values()) clearTimeout(t);
      map.clear();
    };
  }, []);

  const toggle = useCallback(
    ({ messageId, emoji, currentlyByMe }: ToggleArgs) => {
      // 1) 낙관적 패치 + 롤백 스냅샷 확보.
      const prev = qc.getQueryData<InfiniteData<ListMessagesResponse>>(key);
      qc.setQueryData<InfiniteData<ListMessagesResponse>>(key, (old) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((p) => ({
            ...p,
            items: p.items.map((m) => {
              if (m.id !== messageId) return m;
              const bucket = (m.reactions ?? []).find((r) => r.emoji === emoji);
              const currentCount = bucket?.count ?? 0;
              const nextCount = currentlyByMe ? currentCount - 1 : currentCount + 1;
              const next = upsertReactionBucket(m.reactions ?? [], {
                emoji,
                count: nextCount,
                kind: currentlyByMe ? 'removed' : 'added',
                mineChanges: true,
              });
              return { ...m, reactions: next };
            }),
          })),
        };
      });

      // 2) 동일 messageId × 동일 이모지 디바운스 — 직전 타이머 취소 후 재설정.
      const combo = `${messageId}::${emoji}`;
      const existing = timers.current.get(combo);
      if (existing) clearTimeout(existing);
      const handle = setTimeout(() => {
        timers.current.delete(combo);
        // 3) 단일 POST(toggle). 실패 시 직전 스냅샷으로 롤백 + 토스트.
        toggleReaction(messageId, emoji).catch((err: unknown) => {
          if (prev) qc.setQueryData(key, prev);
          const f = friendlyError(err);
          useNotifications.getState().push({
            variant: 'danger',
            title: '리액션 실패',
            body: f.message,
            ttlMs: 4000,
          });
        });
      }, REACTION_DEBOUNCE_MS);
      timers.current.set(combo, handle);
    },
    [qc, key],
  );

  return { toggle };
}
