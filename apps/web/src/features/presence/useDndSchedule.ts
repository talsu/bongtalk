import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DndEntry,
  DndSchedule,
  DndScheduleResponse,
  PresencePreference,
} from '@qufox/shared-types';
import { apiRequest } from '../../lib/api';
import { qk } from '../../lib/query-keys';

/**
 * S28 (FR-P06): DND 주간 스케줄 훅.
 *
 *   GET   /me/dnd-schedule  → { schedule, preference }
 *   PATCH /me/dnd-schedule  { schedule }  → { schedule, preference }
 *
 * 서버는 GET/PATCH 시점에 현재 시각이 구간 안/밖인지 평가해 presencePreference
 * 진입/종료 전이를 auto-toggle 한다(FR-P06). preference 는 평가 후 effective 값이다.
 *
 * day: 0(Sun)~6(Sat), startMin/endMin: 0~1439(분, 자정 기준).
 * startMin>endMin 은 자정 걸침(overnight, 예: 23:00→07:00).
 *
 * contract HIGH fix-forward: DndEntry / DndSchedule / DndScheduleResponse 의 단일
 * 출처는 @qufox/shared-types 다(api/web drift 제거). 로컬 재정의 제거 후 import.
 */
export type { DndEntry, DndSchedule, DndScheduleResponse };
/** preference 별칭 유지(기존 import 호환). */
export type DndPreference = PresencePreference;

export function useDndSchedule() {
  return useQuery({
    queryKey: qk.me.dndSchedule(),
    queryFn: async (): Promise<DndScheduleResponse> =>
      apiRequest<DndScheduleResponse>('/me/dnd-schedule', { method: 'GET' }),
    staleTime: 30_000,
    // S28 (cheap · M1 부분 fix-forward): 60s 주기 refetch 로 스케줄 경계에서 서버의
    // auto-toggle 된 presence 표시(preference)가 UI 에 따라오게 한다. 알림 차단 자체는
    // send-time isDndSuppressed 게이트로 이미 동작하므로 이 폴링은 "표시 동기화" 용도다.
    refetchInterval: 60_000,
  });
}

export function useSetDndSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (schedule: DndSchedule | null): Promise<DndScheduleResponse> =>
      apiRequest<DndScheduleResponse>('/me/dnd-schedule', { method: 'PATCH', body: { schedule } }),
    onSuccess: (data) => {
      qc.setQueryData<DndScheduleResponse>(qk.me.dndSchedule(), data);
    },
  });
}
