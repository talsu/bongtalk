import { apiRequest } from '../../lib/api';

export interface UploadedAttachment {
  id: string;
  originalName: string;
  mime: string;
  sizeBytes: number;
  kind: 'IMAGE' | 'VIDEO' | 'FILE';
}

interface PresignResponse {
  attachmentId: string;
  key: string;
  putUrl: string;
  expiresAt: string;
}

function detectKind(mime: string): 'IMAGE' | 'VIDEO' | 'FILE' {
  if (mime.startsWith('image/')) return 'IMAGE';
  if (mime.startsWith('video/')) return 'VIDEO';
  return 'FILE';
}

/**
 * Client-side attachment upload — three-step presign / PUT / finalize
 * flow matching the backend AttachmentsService contract. Isolated as
 * a plain async function (not a hook) because the composer fires it
 * ad-hoc on file-picker change without needing React Query state.
 */
export async function uploadAttachment(channelId: string, file: File): Promise<UploadedAttachment> {
  const clientAttachmentId = crypto.randomUUID();
  const presign = await apiRequest<PresignResponse>('/attachments/presign-upload', {
    method: 'POST',
    body: {
      clientAttachmentId,
      channelId,
      mime: file.type || 'application/octet-stream',
      sizeBytes: file.size,
      originalName: file.name,
    },
  });

  const put = await fetch(presign.putUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  });
  if (!put.ok) {
    throw new Error(`upload failed: ${put.status} ${put.statusText}`);
  }

  await apiRequest(`/attachments/${presign.attachmentId}/finalize`, {
    method: 'POST',
  });

  return {
    id: presign.attachmentId,
    originalName: file.name,
    mime: file.type || 'application/octet-stream',
    sizeBytes: file.size,
    kind: detectKind(file.type || 'application/octet-stream'),
  };
}
