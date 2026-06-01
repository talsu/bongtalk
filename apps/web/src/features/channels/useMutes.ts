import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '../../lib/api';

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
