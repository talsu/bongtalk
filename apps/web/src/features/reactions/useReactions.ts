import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import type { ListMessagesResponse } from '@qufox/shared-types';
import { toggleReaction } from './api';
import { qk } from '../../lib/query-keys';
import { upsertReactionBucket } from '../realtime/dispatcher';
import { recordReactionIntent, clearReactionIntent } from './reaction-intent';
import { useNotifications } from '../../stores/notification-store';
import { friendlyError } from '../../lib/error-messages';

/**
 * S39 (FR-RE01): toggle 디바운스 윈도우(ms). 동일 messageId × 동일 이모지 조합의
 * 빠른 연속 클릭만 묶는다 — 다른 이모지는 독립 타이머라 즉시 반응한다.
 */
export const REACTION_DEBOUNCE_MS = 300;

type ToggleArgs = { messageId: string; emoji: string; currentlyByMe: boolean };

/**
 * 한 combo(messageId × emoji)의 진행 중인 디바운스 버스트 상태.
 *   - timer:        보류 중인 단일 POST 타이머.
 *   - rollbackSnap: 버스트의 *첫 낙관 패치 이전*에 1회 캡처한 캐시 스냅샷. 실패 시
 *                   이 값으로 복원하므로 버스트 중 누적된 낙관 델타가 섞이지 않는다.
 *   - preBurstByMe: 버스트 시작 시점의 서버상태(=뷰어가 본 byMe). net-intent 계산의
 *                   기준점이다.
 *   - desiredByMe:  지금까지의 클릭을 반영한 터미널(최종) 의도. 클릭마다 토글된다.
 */
type BurstState = {
  timer: ReturnType<typeof setTimeout>;
  rollbackSnap: InfiniteData<ListMessagesResponse> | undefined;
  preBurstByMe: boolean;
  desiredByMe: boolean;
};

/**
 * S39 (FR-RE01): single-call toggle 리액션 훅. 동작 계약:
 *   1. 클릭 즉시 낙관적으로 캐시에 ±1 반영(즉각 UI 피드백).
 *   2. 동일 messageId × 동일 이모지 조합은 300ms 디바운스로 묶는다. 버스트가 끝나면
 *      **net-intent(터미널 의도)** 를 계산한다 — 버스트 시작 시점의 서버상태(byMe)와
 *      최종 의도가 *다를 때만* 단일 toggle POST 를 1회 보낸다. 같으면(짝수 클릭 등
 *      净 no-op) 전송하지 않는다. 종전엔 단일 toggle POST 를 무조건 보내, 짝수 클릭
 *      (UI 상 원상복귀)이 서버 상태를 의도와 반대로 뒤집는 회귀가 있었다.
 *   3. reaction:updated WS 수신 시 dispatcher 가 해당 messageId 반응을 full replace
 *      한다(WS 가 진실값 — GET 재조회 불필요). per-viewer byMe 는 dispatcher 가
 *      reaction-intent 모듈의 뷰어 의도를 우선 참조해 계산한다(★ sticky-ghost 방지).
 *   4. POST 실패(네트워크·409 등) 시 **버스트 시작 시 캡처한 스냅샷**으로 롤백한다
 *      (누적 낙관 델타 미포함 — GET 재조회 불필요). 의도도 함께 정리한다.
 */
export function useToggleReaction(
  wsId: string | null,
  channelId: string,
): { toggle: (args: ToggleArgs) => void } {
  const qc = useQueryClient();
  const key = useMemo(() => qk.messages.list(wsId ?? 'global', channelId), [wsId, channelId]);

  // combo 키(`${messageId}::${emoji}`)별 진행 중 버스트 상태. 같은 조합의 연속 클릭은
  // 직전 타이머를 취소하고 의도를 토글한 뒤 다시 건다(마지막 의도만 네트워크에 반영).
  const bursts = useRef(new Map<string, BurstState>());

  // 언마운트 시 보류 중인 타이머를 모두 정리(leak 방지).
  useEffect(() => {
    const map = bursts.current;
    return () => {
      for (const b of map.values()) clearTimeout(b.timer);
      map.clear();
    };
  }, []);

  const toggle = useCallback(
    ({ messageId, emoji, currentlyByMe }: ToggleArgs) => {
      const combo = `${messageId}::${emoji}`;
      const inFlight = bursts.current.get(combo);

      // 1) 버스트 시작 vs 진행 중 분기 — 롤백 스냅샷·기준 상태는 버스트당 1회만 잡는다.
      let rollbackSnap: InfiniteData<ListMessagesResponse> | undefined;
      let preBurstByMe: boolean;
      let desiredByMe: boolean;
      if (inFlight) {
        clearTimeout(inFlight.timer);
        rollbackSnap = inFlight.rollbackSnap; // 첫 패치 이전 스냅샷 유지.
        preBurstByMe = inFlight.preBurstByMe; // 기준 서버상태 유지.
        desiredByMe = !inFlight.desiredByMe; // 클릭마다 의도를 토글.
      } else {
        // 첫 낙관 패치 *이전* 스냅샷을 캡처(실패 시 누적 델타 없이 정확 복원).
        rollbackSnap = qc.getQueryData<InfiniteData<ListMessagesResponse>>(key);
        preBurstByMe = currentlyByMe;
        desiredByMe = !currentlyByMe;
      }

      // 2) 낙관적 패치 — 현 캐시 카운트 ±1 + byMe = desiredByMe. 뷰어 의도를 기록해
      //    dispatcher 가 sticky-ghost 없이 byMe 를 산정하게 한다.
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
              // 현재 byMe 대비 desired 로 가는 ±1(추가=+1 / 제거=-1).
              const wasByMe = bucket?.byMe ?? false;
              const delta = desiredByMe === wasByMe ? 0 : desiredByMe ? 1 : -1;
              const nextCount = currentCount + delta;
              const next = upsertReactionBucket(m.reactions ?? [], {
                emoji,
                count: nextCount,
                kind: desiredByMe ? 'added' : 'removed',
                mineChanges: true,
              });
              return { ...m, reactions: next };
            }),
          })),
        };
      });
      recordReactionIntent(messageId, emoji, desiredByMe);

      // 3) 디바운스 — 직전 타이머는 위에서 이미 취소했으니 새 타이머만 건다.
      const handle = setTimeout(() => {
        bursts.current.delete(combo);
        // net-intent: 버스트 시작 시 서버상태와 최종 의도가 같으면(짝수 클릭 등 净
        // no-op) 서버에 아무것도 보내지 않는다 — 서버 상태가 의도와 일치하므로.
        if (desiredByMe === preBurstByMe) {
          // 로컬 의도도 정리(이미 합의 상태). dispatcher 가 다음 이벤트부터 순수
          // inUsers 로 계산하도록 둔다.
          clearReactionIntent(messageId, emoji);
          return;
        }
        // 의도가 다르면 단일 toggle POST 를 1회 보낸다(서버를 preBurst → desired 로 1회 뒤집음).
        toggleReaction(messageId, emoji)
          .then((res) => {
            // 서버 권위 byMe 로 의도를 갱신(dispatcher 가 이 값을 존중).
            recordReactionIntent(messageId, emoji, res.byMe);
          })
          .catch((err: unknown) => {
            // 버스트 시작 시 스냅샷으로 정확 롤백 + 의도 제거.
            if (rollbackSnap) qc.setQueryData(key, rollbackSnap);
            clearReactionIntent(messageId, emoji);
            const f = friendlyError(err);
            useNotifications.getState().push({
              variant: 'danger',
              title: '리액션 실패',
              body: f.message,
              ttlMs: 4000,
            });
          });
      }, REACTION_DEBOUNCE_MS);

      bursts.current.set(combo, { timer: handle, rollbackSnap, preBurstByMe, desiredByMe });
    },
    [qc, key],
  );

  return { toggle };
}
