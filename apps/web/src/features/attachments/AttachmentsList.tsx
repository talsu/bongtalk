import { useEffect, useState } from 'react';
import type { AttachmentLite } from '@qufox/shared-types';
import { Icon } from '../../design-system/primitives';
import { cn } from '../../lib/cn';
import { formatSize } from './formatSize';
import { downloadAttachment, fetchAttachmentObjectUrl, type ProxyVariant } from './attachmentSrc';
import { AttachmentSpoilerOverlay } from './AttachmentSpoilerOverlay';

/**
 * S56 (D11 / FR-AM-21/22) — 메시지 첨부 렌더러.
 *
 * 캐논 AttachmentLite(@qufox/shared-types)를 직접 소비합니다(로컬 인터페이스 제거).
 * 분기:
 *   processingStatus PENDING/PROCESSING → qf-skel(비율 예약 — 후처리 대기)
 *   READY + IMAGE  → <img>(thumbnailKey 있으면 /thumbnail, 없으면 /download).
 *                    spoiler 면 AttachmentSpoilerOverlay 로 감쌉니다.
 *   VIDEO          → 파일 카드(다운로드. MVP 는 인라인 <video> 미사용 — 편차).
 *   FILE + audio/* → <audio controls>
 *   FILE           → 아이콘 카드 + 다운로드 버튼
 *
 * 다운로드/미리보기는 모두 S55 프록시(/attachments/:id/download|thumbnail)를 인증
 * fetch → objectURL 로 소비합니다(별도 download-url presign API 호출 제거).
 */
export function AttachmentsList({
  attachments,
}: {
  attachments: AttachmentLite[];
}): JSX.Element | null {
  if (!attachments || attachments.length === 0) return null;
  return (
    <ul data-testid="message-attachments" className="mt-[var(--s-2)] space-y-[var(--s-1)]">
      {[...attachments]
        .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
        .map((a) => (
          <AttachmentRow key={a.id} attachment={a} />
        ))}
    </ul>
  );
}

function isAudio(att: AttachmentLite): boolean {
  return (att.storedMimeType ?? att.mime).startsWith('audio/');
}

function AttachmentRow({ attachment }: { attachment: AttachmentLite }): JSX.Element {
  const status = attachment.processingStatus ?? 'READY';
  const pending = status === 'PENDING' || status === 'PROCESSING';

  // PENDING/PROCESSING → 비율 예약 스켈레톤.
  if (pending) {
    return (
      <li data-testid={`attachment-skeleton-${attachment.id}`} data-attachment-id={attachment.id}>
        <div
          role="img"
          aria-label="처리 중"
          className="qf-skel"
          style={{ width: '240px', height: '160px' }}
        />
      </li>
    );
  }

  if (attachment.kind === 'IMAGE') {
    return <ImageAttachment attachment={attachment} />;
  }

  // FILE + audio/* → 인라인 오디오 플레이어.
  if (attachment.kind === 'FILE' && isAudio(attachment)) {
    return <AudioAttachment attachment={attachment} />;
  }

  // VIDEO(MVP: 인라인 미재생, 파일 카드) + 그 외 FILE → 다운로드 카드.
  return <FileCard attachment={attachment} />;
}

/**
 * 인증 fetch → objectURL 로 미리보기 src 를 얻는다.
 *
 * S56 fix-forward (perf CRITICAL): objectURL 의 수명은 attachmentSrc 의 모듈
 * LRU 캐시가 소유한다. 따라서 언마운트/재마운트(채널 전환) 시 revoke 하지 않고
 * (revoke 하면 캐시에 남은 동일 url 이 깨진다), 캐시 hit 시 fetch 가 생략돼
 * 채널 재진입마다 50장 재다운로드하던 회귀를 막는다. revoke 는 LRU eviction
 * 시에만 캐시 내부에서 일어난다.
 */
function useProxyObjectUrl(
  id: string,
  variant: ProxyVariant,
): { url: string | null; error: boolean } {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let aborted = false;
    setError(false);
    setUrl(null);
    fetchAttachmentObjectUrl(id, variant)
      .then((u) => {
        if (aborted) return;
        setUrl(u);
      })
      .catch(() => {
        if (!aborted) setError(true);
      });
    return () => {
      // url revoke 안 함 — 캐시가 수명을 소유(채널 재진입 재fetch 회피).
      aborted = true;
    };
  }, [id, variant]);
  return { url, error };
}

function ImageAttachment({ attachment }: { attachment: AttachmentLite }): JSX.Element {
  // thumbnailKey 있으면 썸네일 변형, 없으면 원본 download.
  const variant: ProxyVariant = attachment.thumbnailKey ? 'thumbnail' : 'download';
  const { url, error } = useProxyObjectUrl(attachment.id, variant);
  const alt = attachment.altText ?? attachment.originalName;
  // 비율 예약: width/height 신고가 있으면 aspect-ratio 로 CLS 방지.
  const ratioStyle =
    attachment.width && attachment.height
      ? { aspectRatio: `${attachment.width} / ${attachment.height}`, maxWidth: '400px' }
      : { maxWidth: '400px' };

  if (error) {
    return (
      <li
        data-testid={`attachment-error-${attachment.id}`}
        className="text-[length:var(--fs-13)] text-[color:var(--danger-400)]"
      >
        첨부를 불러오지 못했습니다.
      </li>
    );
  }

  const img = url ? (
    <img
      src={url}
      alt={alt}
      loading="lazy"
      className="block max-h-96 w-full rounded-[var(--r-md)] border border-border-subtle object-cover"
      style={ratioStyle}
    />
  ) : (
    <div
      className="qf-skel"
      role="img"
      aria-label="처리 중"
      style={{ ...ratioStyle, height: '160px' }}
    />
  );

  return (
    <li data-testid={`attachment-image-${attachment.id}`} data-attachment-id={attachment.id}>
      {attachment.isSpoiler ? (
        <AttachmentSpoilerOverlay label={alt}>{img}</AttachmentSpoilerOverlay>
      ) : (
        img
      )}
    </li>
  );
}

function AudioAttachment({ attachment }: { attachment: AttachmentLite }): JSX.Element {
  const { url, error } = useProxyObjectUrl(attachment.id, 'download');
  return (
    <li
      data-testid={`attachment-audio-${attachment.id}`}
      data-attachment-id={attachment.id}
      className="flex flex-col gap-[var(--s-1)] rounded-[var(--r-md)] border border-border-subtle bg-bg-surface p-[var(--s-2)]"
    >
      <span className="truncate text-[length:var(--fs-13)] text-[color:var(--text)]">
        {attachment.originalName}
      </span>
      {error ? (
        <span className="text-[length:var(--fs-11)] text-[color:var(--danger-400)]">
          오디오를 불러오지 못했습니다.
        </span>
      ) : url ? (
        <audio
          controls
          src={url}
          aria-label={`${attachment.originalName} 오디오`}
          className="w-full"
        />
      ) : (
        <div className="qf-skel" role="img" aria-label="처리 중" style={{ height: '36px' }} />
      )}
    </li>
  );
}

function FileCard({ attachment }: { attachment: AttachmentLite }): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const isVideo = attachment.kind === 'VIDEO';
  return (
    <li
      data-testid={`attachment-file-${attachment.id}`}
      data-attachment-id={attachment.id}
      className="flex items-center gap-[var(--s-2)] rounded-[var(--r-md)] border border-border-subtle bg-bg-surface p-[var(--s-2)] text-[length:var(--fs-13)]"
    >
      <Icon name={isVideo ? 'video' : 'file'} size="md" className="text-text-muted" />
      <span
        className="min-w-0 flex-1 truncate text-[color:var(--text)]"
        title={attachment.originalName}
      >
        {attachment.originalName}
      </span>
      <span className="text-[length:var(--fs-11)] text-text-muted">
        {formatSize(attachment.sizeBytes)}
      </span>
      <button
        type="button"
        data-testid={`attachment-download-${attachment.id}`}
        aria-label={`${attachment.originalName} 다운로드`}
        onClick={() => {
          setError(null);
          void downloadAttachment(attachment.id, attachment.originalName).catch(() =>
            setError('다운로드 실패'),
          );
        }}
        className="qf-btn qf-btn--secondary qf-btn--sm inline-flex items-center gap-[var(--s-1)]"
      >
        <Icon name="download" size="sm" />
        다운로드
      </button>
      {error ? (
        <span
          role="alert"
          className={cn('text-[length:var(--fs-11)] text-[color:var(--danger-400)]')}
        >
          {error}
        </span>
      ) : null}
    </li>
  );
}
