import { apiRequest } from '../../lib/api';

export interface CustomEmoji {
  id: string;
  name: string;
  // S41/S42: 서버 list 응답은 항상 aliases 를 포함한다(S42 부터 실제 별칭 — FR-EM05).
  // optional 로 둬 기존 클라 구성부(컨텍스트 byName Map 등)를 비파괴로 확장한다.
  aliases?: string[];
  createdBy: string;
  createdAt: string;
  url: string;
  urlExpiresAt: string;
  sizeBytes: number;
  mime: string;
}

/**
 * S42 (FR-PK01): GET /workspaces/:wsId/emoji-picker-data 응답. 피커 초기 데이터 —
 * 커스텀 이모지(별칭 포함) + 워크스페이스/사용자 퀵반응 + 최근 이모지 + skinTone.
 */
export interface EmojiPickerData {
  customEmojis: CustomEmoji[];
  workspaceQuickReactions: string[];
  userQuickReactions: string[] | null;
  recentEmojis: string[];
  defaultSkinTone: number;
}

/** S42 (FR-PK03): PUT /me/emoji-preferences 응답(전체 행). */
export interface UserEmojiPreference {
  defaultSkinTone: number;
  quickReactions: string[];
  recentEmojis: string[];
}

/** S42 (FR-PK04): PATCH /workspaces/:wsId/emoji-config 응답(전체 행). */
export interface WorkspaceEmojiConfig {
  quickReactions: string[];
  canMemberUpload: boolean;
}

interface PresignEmojiResponse {
  emojiId: string;
  storageKey: string;
  putUrl: string;
  expiresAt: string;
}

export function listCustomEmojis(workspaceId: string): Promise<{ items: CustomEmoji[] }> {
  return apiRequest(`/workspaces/${workspaceId}/emojis`);
}

export function deleteCustomEmoji(workspaceId: string, emojiId: string): Promise<void> {
  return apiRequest(`/workspaces/${workspaceId}/emojis/${emojiId}`, { method: 'DELETE' });
}

// ── S42 (D05) ────────────────────────────────────────────────────────────────

/** FR-PK01: 피커 초기 데이터 통합 조회. */
export function getEmojiPickerData(workspaceId: string): Promise<EmojiPickerData> {
  return apiRequest(`/workspaces/${workspaceId}/emoji-picker-data`);
}

/** FR-EM05: 별칭 추가. 201 + { aliases }(변경 후 전체 별칭 스냅샷). */
export function addEmojiAlias(
  workspaceId: string,
  emojiId: string,
  alias: string,
): Promise<{ aliases: string[] }> {
  return apiRequest(`/workspaces/${workspaceId}/emojis/${emojiId}/aliases`, {
    method: 'POST',
    body: { alias },
  });
}

/** FR-EM05: 별칭 삭제. 204. */
export function removeEmojiAlias(
  workspaceId: string,
  emojiId: string,
  alias: string,
): Promise<void> {
  return apiRequest(
    `/workspaces/${workspaceId}/emojis/${emojiId}/aliases/${encodeURIComponent(alias)}`,
    { method: 'DELETE' },
  );
}

/** FR-PK03: 사용자 이모지 선호 저장. 200 + 전체 행. */
export function putUserEmojiPreference(body: {
  defaultSkinTone?: number;
  quickReactions?: string[];
  recentEmojis?: string[];
}): Promise<UserEmojiPreference> {
  return apiRequest(`/me/emoji-preferences`, { method: 'PUT', body });
}

/** FR-PK04: 워크스페이스 이모지 설정 변경(OWNER/ADMIN). 200 + 전체 행. */
export function patchWorkspaceEmojiConfig(
  workspaceId: string,
  body: { quickReactions?: string[]; canMemberUpload?: boolean },
): Promise<WorkspaceEmojiConfig> {
  return apiRequest(`/workspaces/${workspaceId}/emoji-config`, { method: 'PATCH', body });
}

/**
 * task-037-D: three-step custom emoji upload — presign, PUT, finalize.
 * Mirrors the attachment flow but against `/workspaces/:wsId/emojis`.
 * Only PNG + GIF under 256 KB are accepted (server + DTO both enforce).
 */
export async function uploadCustomEmoji(
  workspaceId: string,
  name: string,
  file: File,
): Promise<{ emojiId: string }> {
  const presign = await apiRequest<PresignEmojiResponse>(
    `/workspaces/${workspaceId}/emojis/presign-upload`,
    {
      method: 'POST',
      body: {
        name,
        mime: file.type,
        sizeBytes: file.size,
        filename: file.name,
      },
    },
  );

  const put = await fetch(presign.putUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type },
    body: file,
  });
  if (!put.ok) {
    throw new Error(`upload failed: ${put.status} ${put.statusText}`);
  }

  await apiRequest(`/workspaces/${workspaceId}/emojis/${presign.emojiId}/finalize`, {
    method: 'POST',
  });

  return { emojiId: presign.emojiId };
}
