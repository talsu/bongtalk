import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Favorite, FavoritesResponse, MoveFavoriteRequest } from '@qufox/shared-types';
import { addFavorite, listFavorites, moveFavorite, removeFavorite } from './api';

/**
 * S43 (FR-CH-15): 채널 즐겨찾기 상태 소스.
 *
 * 동기화 = 옵션 B(outbox 없음): useMutes 와 동일하게 refetchOnWindowFocus +
 * staleTime(30s). 즐겨찾기는 개인 상태·저빈도라 다기기 실시간 푸시 없이
 * 포커스 복귀 시 재요청으로 충분하다(실시간 옵션 A 는 후속 슬라이스).
 *
 * GET /me/favorites 는 사용자 전체(워크스페이스 무관) 즐겨찾기를 position
 * 오름차순으로 반환한다. 사이드바 섹션은 현재 워크스페이스 채널 id 와
 * 교집합해 렌더한다(다른 워크스페이스 즐겨찾기는 클라가 무시).
 */
const FAVORITES_KEY = ['me', 'favorites'] as const;

export function useFavorites() {
  return useQuery<FavoritesResponse>({
    queryKey: FAVORITES_KEY,
    queryFn: () => listFavorites(),
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
}

/**
 * 즐겨찾기 channelId → position 맵. 행마다 O(1) 조회(즐겨찾기 여부 + 정렬값).
 * 순서 자체는 useFavorites().data.items 가 이미 position asc 로 정렬돼 있다.
 */
export function useFavoriteChannelIds(): Set<string> {
  const { data } = useFavorites();
  return useMemo(() => new Set((data?.items ?? []).map((f) => f.channelId)), [data]);
}

export function useAddFavorite(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (channelId: string) => addFavorite(wsId, channelId),
    onSuccess: () => qc.invalidateQueries({ queryKey: FAVORITES_KEY }),
  });
}

export function useRemoveFavorite(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (channelId: string) => removeFavorite(wsId, channelId),
    onSuccess: () => qc.invalidateQueries({ queryKey: FAVORITES_KEY }),
  });
}

export function useMoveFavorite(wsId: string) {
  const qc = useQueryClient();
  return useMutation<Favorite, Error, { channelId: string; input: MoveFavoriteRequest }>({
    mutationFn: ({ channelId, input }) => moveFavorite(wsId, channelId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: FAVORITES_KEY }),
  });
}
