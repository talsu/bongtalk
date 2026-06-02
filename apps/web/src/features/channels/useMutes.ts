import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '../../lib/api';
import { removeChannelMute, setChannelMute } from './api';

/**
 * S22 (FR-RS-05 / FR-DM-15): 채널·DM 뮤트 상태 소스.
 *
 * GET /me/mutes 는 S20 UserChannelMute 중 **활성** 행만 반환한다(서버가
 * mutedUntil null=무기한 / 미래=만료전 을 query-time 에 필터링하므로 클라는
 * 만료 판정 불필요). 사이드바 채널 행(FR-RS-05)과 DM 행(FR-DM-15)이 동일
 * channelId 집합으로 뮤트 여부를 조회한다.
 */
export interface ActiveMute {
  channelId: string;
  /** ISO 8601 또는 null(무기한). */
  mutedUntil: string | null;
}

interface MutesResponse {
  items: ActiveMute[];
}

export function useMutes() {
  return useQuery({
    queryKey: ['me', 'mutes'],
    queryFn: () => apiRequest<MutesResponse>('/me/mutes'),
    // 뮤트 변경은 저빈도지만 다른 기기에서의 토글을 포커스 복귀 시 반영.
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
}

/**
 * S22 review #8: 클라 시계로 만료 뮤트를 1차 필터한 channelId Set 을 만든다.
 *
 * 서버는 query-time 에 만료 행을 걸러 주지만, 응답을 캐시한 뒤 `mutedUntil`
 * 이 미래→과거로 넘어가면 다음 refetch 전까지 억제가 지속된다. 무기한
 * (mutedUntil=null) 또는 `mutedUntil > now` 인 항목만 활성으로 본다
 * (staleTime 30s 갭 보정). 순수 함수로 빼 결정적으로 단위 검증한다.
 */
export function activeMutedChannelIds(items: ActiveMute[], now: number): Set<string> {
  const active = items.filter(
    (m) => m.mutedUntil == null || new Date(m.mutedUntil).getTime() > now,
  );
  return new Set(active.map((m) => m.channelId));
}

/**
 * 뮤트된 channelId Set 으로 가공. 컴포넌트가 행마다 O(1) 조회하도록 한다.
 * data 가 없으면 빈 Set. 만료 필터는 {@link activeMutedChannelIds} 가 담당.
 */
export function useMutedChannelIds(): Set<string> {
  const { data } = useMutes();
  return useMemo(() => activeMutedChannelIds(data?.items ?? [], Date.now()), [data]);
}

/**
 * S43 (FR-CH-17): 뮤트 지속시간 선택지. PRD: 15분/1시간/3시간/8시간/24시간/무기한.
 * `'forever'` 는 mutedUntil=null(무기한)을 뜻한다.
 */
export type MuteDurationKey = '15m' | '1h' | '3h' | '8h' | '24h' | 'forever';

const MUTE_DURATION_MS: Record<Exclude<MuteDurationKey, 'forever'>, number> = {
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '3h': 3 * 60 * 60_000,
  '8h': 8 * 60 * 60_000,
  '24h': 24 * 60 * 60_000,
};

/**
 * S43 (FR-CH-17): 지속시간 선택을 서버가 받는 `until`(ISO 또는 null)로 변환.
 * 'forever' → null(무기한), 그 외 → now + 해당 밀리초의 ISO. 순수 함수로 빼
 * vi.setSystemTime 기반 단위 검증을 결정적으로 한다.
 */
export function muteUntilIso(duration: MuteDurationKey, now: number): string | null {
  if (duration === 'forever') return null;
  return new Date(now + MUTE_DURATION_MS[duration]).toISOString();
}

/**
 * S43 (FR-CH-17): 채널 뮤트 설정 mutation. duration → until 변환 후
 * POST /me/mutes/channels/:channelId {until}. 성공 시 me/mutes 무효화.
 */
export function useSetChannelMute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ channelId, duration }: { channelId: string; duration: MuteDurationKey }) =>
      setChannelMute(channelId, muteUntilIso(duration, Date.now())),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me', 'mutes'] }),
  });
}

/**
 * S43 (FR-CH-17): 채널 뮤트 해제 mutation. DELETE /me/mutes/channels/:channelId.
 * 성공 시 me/mutes 무효화.
 */
export function useRemoveChannelMute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (channelId: string) => removeChannelMute(channelId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me', 'mutes'] }),
  });
}
