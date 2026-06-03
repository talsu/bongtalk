import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SavedMessageDto, SavedMessageListResponse } from '@qufox/shared-types';
import { useNotifications } from '../../stores/notification-store';
import { listOverdueReminders, setReminder, snoozeReminder } from './api';

// S53 (D10 / FR-PS-09/10): 저장 항목 리마인더 설정/취소 + 스누즈 훅.
//
// 설정/취소 후 저장 목록(전 탭) + count 를 무효화해 bell 배지/시각이 서버 권위로
// 재동기화되게 한다. 낙관적 캐시 갱신은 하지 않는다(리마인더 빈도가 낮아 단순
// invalidate 로 충분 — 토글/이동의 낙관 갱신과 달리 즉시성 요구가 약함).

function invalidateSaved(qc: ReturnType<typeof useQueryClient>): void {
  void qc.invalidateQueries({ queryKey: ['saved', 'list'] });
  void qc.invalidateQueries({ queryKey: ['saved', 'count'] });
  // S53 리뷰(reviewer M1): ['saved','overdue'] 는 ['saved','list'] 의 sibling 이라
  // prefix 무효화에 안 걸린다. 명시적으로 무효화해야 발화/설정 후 놓친-리마인더
  // 배너가 갱신된다(FR-PS-11 online-at-fire 회귀 방지).
  void qc.invalidateQueries({ queryKey: ['saved', 'overdue'] });
}

/**
 * 리마인더 설정/취소. reminderAt=null 이면 취소. 실패 시 경고 토스트.
 */
export function useSetReminder() {
  const qc = useQueryClient();
  const pushToast = useNotifications((s) => s.push);
  return useMutation({
    mutationFn: ({
      savedMessageId,
      reminderAt,
    }: {
      savedMessageId: string;
      reminderAt: string | null;
    }): Promise<SavedMessageDto> => setReminder(savedMessageId, reminderAt),
    onSuccess: (_data, vars) => {
      invalidateSaved(qc);
      pushToast({
        variant: 'success',
        title: vars.reminderAt === null ? '리마인더를 해제했습니다' : '리마인더를 설정했습니다',
        ttlMs: 2500,
      });
    },
    onError: () => {
      pushToast({ variant: 'warning', title: '리마인더를 설정하지 못했습니다', ttlMs: 4000 });
    },
  });
}

/**
 * "10분 후 다시 알림"(스누즈). 발화 토스트의 액션 또는 항목 메뉴에서 호출.
 */
export function useSnoozeReminder() {
  const qc = useQueryClient();
  const pushToast = useNotifications((s) => s.push);
  return useMutation({
    mutationFn: (savedMessageId: string): Promise<SavedMessageDto> =>
      snoozeReminder(savedMessageId),
    onSuccess: () => {
      invalidateSaved(qc);
      pushToast({ variant: 'success', title: '10분 후 다시 알려드립니다', ttlMs: 2500 });
    },
    onError: () => {
      pushToast({ variant: 'warning', title: '다시 알림 설정에 실패했습니다', ttlMs: 4000 });
    },
  });
}

/**
 * S53 (FR-PS-11): 놓친 리마인더(reminderAt < now AND reminderFiredAt IS NOT NULL
 * AND status != COMPLETED). 앱/저장함 진입 시 1회 조회해 가벼운 배너로 표시한다
 * (재접속 동안 발화를 놓쳤을 때 사용자가 인지하도록). staleTime 으로 과조회 방지.
 */
export function useOverdueReminders() {
  return useQuery<SavedMessageListResponse>({
    queryKey: ['saved', 'overdue'],
    queryFn: () => listOverdueReminders(),
    staleTime: 60_000,
  });
}
