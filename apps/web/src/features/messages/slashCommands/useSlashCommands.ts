import { useQuery } from '@tanstack/react-query';
import type { SlashCommandItem } from '@qufox/shared-types';
import { listSlashCommands } from './api';

/**
 * S79 (D15 / FR-SC-01) — 워크스페이스 슬래시 커맨드 목록 캐시.
 *
 * 빌트인 상수 + 워크스페이스 커스텀 병합 목록을 GET 한다. 슬래시 커맨드 집합은
 * 자주 바뀌지 않으므로(빌트인은 정적, 커스텀 CRUD 는 S81) staleTime 5분으로 캐시해
 * 컴포저가 `/` 입력 시 추가 네트워크 왕복 없이 즉시 자동완성을 채운다.
 *
 * workspaceId 가 null/undefined(Global DM 등 워크스페이스 네임스페이스 없음)면
 * enabled=false 로 쿼리를 끈다 — MessageComposer 가 slash 트리거 자체를 끄는 것과 일관.
 */
const STALE_5M = 5 * 60 * 1000;

export function useSlashCommands(workspaceId: string | null | undefined) {
  return useQuery<SlashCommandItem[]>({
    queryKey: ['slash-commands', workspaceId ?? ''],
    queryFn: () => listSlashCommands(workspaceId as string),
    enabled: Boolean(workspaceId),
    staleTime: STALE_5M,
  });
}
