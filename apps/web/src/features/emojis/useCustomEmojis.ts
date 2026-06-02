import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  listCustomEmojis,
  deleteCustomEmoji,
  uploadCustomEmoji,
  getEmojiPickerData,
  addEmojiAlias,
  removeEmojiAlias,
  putUserEmojiPreference,
  patchWorkspaceEmojiConfig,
  type CustomEmoji,
  type EmojiPickerData,
} from './api';

/**
 * task-037-D: workspace custom emoji cache. 10-minute staleTime matches
 * the presigned GET URL TTL (30 min) with enough headroom for the
 * browser to keep an image rendered even after the query becomes stale,
 * but short enough that a newly-uploaded emoji becomes pickable without
 * a manual refresh.
 */
const STALE_10M = 10 * 60 * 1000;

export function useCustomEmojis(workspaceId: string | undefined | null) {
  return useQuery<{ items: CustomEmoji[] }>({
    queryKey: ['custom-emojis', workspaceId ?? ''],
    queryFn: () => listCustomEmojis(workspaceId as string),
    enabled: Boolean(workspaceId),
    staleTime: STALE_10M,
  });
}

export function useUploadCustomEmoji(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, file }: { name: string; file: File }) =>
      uploadCustomEmoji(workspaceId, name, file),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['custom-emojis', workspaceId] });
    },
  });
}

export function useDeleteCustomEmoji(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (emojiId: string) => deleteCustomEmoji(workspaceId, emojiId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['custom-emojis', workspaceId] });
    },
  });
}

// ── S42 (D05) ────────────────────────────────────────────────────────────────

/**
 * FR-PK01: 피커 초기 데이터. 커스텀 이모지 list 와 동일한 10분 staleTime 을 쓴다
 * (퀵반응/최근/skinTone 은 자주 바뀌지 않고, 피커 오픈 시 신선도가 충분하다).
 */
export function useEmojiPickerData(workspaceId: string | undefined | null) {
  return useQuery<EmojiPickerData>({
    queryKey: ['emoji-picker-data', workspaceId ?? ''],
    queryFn: () => getEmojiPickerData(workspaceId as string),
    enabled: Boolean(workspaceId),
    staleTime: STALE_10M,
  });
}

/**
 * FR-EM05: 별칭 추가. 성공 시 커스텀 이모지 목록 + 피커 데이터를 무효화해 파서/
 * 자동완성/피커가 새 별칭을 다음 read 로 반영하게 한다(WS emoji:alias_updated 가
 * 다른 탭/기기를 갱신하지만, 본 탭은 mutation onSuccess 로 즉시 재수렴한다).
 */
export function useAddEmojiAlias(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ emojiId, alias }: { emojiId: string; alias: string }) =>
      addEmojiAlias(workspaceId, emojiId, alias),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['custom-emojis', workspaceId] });
      void qc.invalidateQueries({ queryKey: ['emoji-picker-data', workspaceId] });
    },
  });
}

/** FR-EM05: 별칭 삭제. */
export function useRemoveEmojiAlias(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ emojiId, alias }: { emojiId: string; alias: string }) =>
      removeEmojiAlias(workspaceId, emojiId, alias),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['custom-emojis', workspaceId] });
      void qc.invalidateQueries({ queryKey: ['emoji-picker-data', workspaceId] });
    },
  });
}

/** FR-PK03: 사용자 이모지 선호 저장. 성공 시 모든 워크스페이스 피커 데이터 무효화. */
export function usePutUserEmojiPreference() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      defaultSkinTone?: number;
      quickReactions?: string[];
      recentEmojis?: string[];
    }) => putUserEmojiPreference(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['emoji-picker-data'] });
    },
  });
}

/** FR-PK04: 워크스페이스 이모지 설정 변경. 성공 시 그 워크스페이스 피커 데이터 무효화. */
export function usePatchWorkspaceEmojiConfig(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { quickReactions?: string[]; canMemberUpload?: boolean }) =>
      patchWorkspaceEmojiConfig(workspaceId, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['emoji-picker-data', workspaceId] });
    },
  });
}
