import { useEffect, useState } from 'react';
import { apiRequest } from '../../lib/api';

export interface AttachmentLite {
  id: string;
  kind: 'IMAGE' | 'VIDEO' | 'FILE';
  mime: string;
  sizeBytes: number;
  originalName: string;
}

interface DownloadUrlResponse {
  downloadUrl: string;
  expiresAt: string;
  mime: string;
  originalName: string;
  sizeBytes: number;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Task-012-C: renderer for a message's attachments list.
 * Fetches a presigned URL lazily (on mount for IMAGE/VIDEO; on click
 * for FILE so clicking "Download" doesn't need a separate round-trip).
 * Re-fetches on remount — the presign TTL is 30 min so cross-session
 * URL reuse would 403; we prefer the extra request.
 */
export function AttachmentsList({
  attachments,
}: {
  attachments: AttachmentLite[];
}): JSX.Element | null {
  if (!attachments || attachments.length === 0) return null;
  return (
    <ul data-testid="message-attachments" className="mt-2 space-y-1">
      {attachments.map((a) => (
        <AttachmentRow key={a.id} attachment={a} />
      ))}
    </ul>
  );
}

function AttachmentRow({ attachment }: { attachment: AttachmentLite }): JSX.Element {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // IMAGE / VIDEO need the URL to render; FILE fetches on click.
    if (attachment.kind === 'FILE') return;
    let aborted = false;
    apiRequest<DownloadUrlResponse>(`/attachments/${attachment.id}/download-url`)
      .then((r) => {
        if (!aborted) setUrl(r.downloadUrl);
      })
      .catch((e) => {
        if (!aborted) setError((e as Error).message);
      });
    return () => {
      aborted = true;
    };
  }, [attachment.id, attachment.kind]);

  if (error) {
    return (
      <li data-testid={`attachment-error-${attachment.id}`} className="text-xs text-danger">
        attachment unavailable: {error}
      </li>
    );
  }

  if (attachment.kind === 'IMAGE') {
    return (
      <li
        data-testid={`attachment-image-${attachment.id}`}
        data-attachment-id={attachment.id}
        className="overflow-hidden rounded-md border border-border-subtle"
      >
        {url ? (
          <img
            src={url}
            alt={attachment.originalName}
            loading="lazy"
            className="max-h-96 max-w-full"
          />
        ) : (
          <div className="h-24 w-48 animate-pulse bg-bg-accent" />
        )}
      </li>
    );
  }

  if (attachment.kind === 'VIDEO') {
    return (
      <li data-testid={`attachment-video-${attachment.id}`} data-attachment-id={attachment.id}>
        {url ? (
          <video controls preload="metadata" className="max-h-96 max-w-full rounded-md">
            <source src={url} type={attachment.mime} />
          </video>
        ) : (
          <div className="h-24 w-48 animate-pulse bg-bg-accent" />
        )}
      </li>
    );
  }

  // FILE: show a card with a Download button that fetches the URL
  // on click (deferred fetch — keeps the message feed cheap).
  return (
    <li
      data-testid={`attachment-file-${attachment.id}`}
      data-attachment-id={attachment.id}
      className="flex items-center gap-2 rounded-md border border-border-subtle bg-bg-surface p-2 text-sm"
    >
      <span className="flex-1 truncate">{attachment.originalName}</span>
      <span className="text-xs text-text-muted">{formatSize(attachment.sizeBytes)}</span>
      <button
        type="button"
        data-testid={`attachment-download-${attachment.id}`}
        onClick={async () => {
          try {
            const r = await apiRequest<DownloadUrlResponse>(
              `/attachments/${attachment.id}/download-url`,
            );
            window.open(r.downloadUrl, '_blank', 'noopener,noreferrer');
          } catch (e) {
            setError((e as Error).message);
          }
        }}
        className="rounded-md bg-bg-primary px-2 py-1 text-xs text-fg-primary hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Download
      </button>
    </li>
  );
}
