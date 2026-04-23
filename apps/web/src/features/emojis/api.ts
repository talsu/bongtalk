import { apiRequest } from '../../lib/api';

export interface CustomEmoji {
  id: string;
  name: string;
  createdBy: string;
  createdAt: string;
  url: string;
  urlExpiresAt: string;
  sizeBytes: number;
  mime: string;
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
