import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateSidebarSectionRequest,
  MoveSidebarChannelRequest,
  MoveSidebarSectionRequest,
  SidebarSection,
  SidebarSectionsResponse,
  UpdateSidebarSectionRequest,
} from '@qufox/shared-types';
import {
  assignSidebarChannel,
  createSidebarSection,
  deleteSidebarSection,
  listSidebarSections,
  moveSidebarChannel,
  moveSidebarSection,
  unassignSidebarChannel,
  updateSidebarSection,
} from './api';

/**
 * S85 (FR-CH-16): 사이드바 개인 섹션 상태 소스.
 *
 * 동기화 = useFavorites 와 동일 옵션(refetchOnWindowFocus + staleTime 30s). 섹션은
 * 개인 상태·저빈도라 다기기 실시간 푸시 없이 포커스 복귀 재요청으로 충분하다.
 *
 * 목록은 워크스페이스 스코프(GET /workspaces/:id/sidebar-sections) — position asc 로
 * 정렬된 섹션 + 각 섹션 channelIds(섹션 내 순서). 재정렬/할당 mutation 은 낙관적
 * 업데이트(setQueryData)로 즉시 반영하고, 실패 시 invalidate 로 서버 진실로 롤백한다.
 */
function sidebarSectionsKey(wsId: string) {
  return ['workspaces', wsId, 'sidebar-sections'] as const;
}

export function useSidebarSections(wsId: string) {
  return useQuery<SidebarSectionsResponse>({
    queryKey: sidebarSectionsKey(wsId),
    queryFn: () => listSidebarSections(wsId),
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
}

/** 섹션에 할당된 모든 channelId 집합 — 카테고리 기본 위치에서 제외할 채널 판별. */
export function useAssignedChannelIds(wsId: string): Set<string> {
  const { data } = useSidebarSections(wsId);
  return useMemo(() => {
    const s = new Set<string>();
    for (const sec of data?.sections ?? []) for (const id of sec.channelIds) s.add(id);
    return s;
  }, [data]);
}

export function useCreateSidebarSection(wsId: string) {
  const qc = useQueryClient();
  return useMutation<SidebarSection, Error, CreateSidebarSectionRequest>({
    mutationFn: (input) => createSidebarSection(wsId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: sidebarSectionsKey(wsId) }),
  });
}

export function useUpdateSidebarSection(wsId: string) {
  const qc = useQueryClient();
  return useMutation<
    SidebarSection,
    Error,
    { sectionId: string; input: UpdateSidebarSectionRequest }
  >({
    mutationFn: ({ sectionId, input }) => updateSidebarSection(wsId, sectionId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: sidebarSectionsKey(wsId) }),
  });
}

export function useDeleteSidebarSection(wsId: string) {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (sectionId) => deleteSidebarSection(wsId, sectionId),
    onSuccess: () => qc.invalidateQueries({ queryKey: sidebarSectionsKey(wsId) }),
  });
}

export function useMoveSidebarSection(wsId: string) {
  const qc = useQueryClient();
  return useMutation<
    SidebarSection,
    Error,
    { sectionId: string; input: MoveSidebarSectionRequest }
  >({
    mutationFn: ({ sectionId, input }) => moveSidebarSection(wsId, sectionId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: sidebarSectionsKey(wsId) }),
  });
}

export function useAssignSidebarChannel(wsId: string) {
  const qc = useQueryClient();
  return useMutation<SidebarSection, Error, { sectionId: string; channelId: string }>({
    mutationFn: ({ sectionId, channelId }) => assignSidebarChannel(wsId, sectionId, channelId),
    onSuccess: () => qc.invalidateQueries({ queryKey: sidebarSectionsKey(wsId) }),
  });
}

export function useUnassignSidebarChannel(wsId: string) {
  const qc = useQueryClient();
  return useMutation<SidebarSection, Error, { sectionId: string; channelId: string }>({
    mutationFn: ({ sectionId, channelId }) => unassignSidebarChannel(wsId, sectionId, channelId),
    onSuccess: () => qc.invalidateQueries({ queryKey: sidebarSectionsKey(wsId) }),
  });
}

export function useMoveSidebarChannel(wsId: string) {
  const qc = useQueryClient();
  return useMutation<
    SidebarSection,
    Error,
    { channelId: string; input: MoveSidebarChannelRequest }
  >({
    mutationFn: ({ channelId, input }) => moveSidebarChannel(wsId, channelId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: sidebarSectionsKey(wsId) }),
  });
}
