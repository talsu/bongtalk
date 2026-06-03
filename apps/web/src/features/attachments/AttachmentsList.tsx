import { useState, type CSSProperties } from 'react';
import type { AttachmentLite } from '@qufox/shared-types';
import { Icon } from '../../design-system/primitives';
import { cn } from '../../lib/cn';
import { formatSize } from './formatSize';
import { downloadAttachment, type ProxyVariant } from './attachmentSrc';
import { AttachmentSpoilerOverlay } from './AttachmentSpoilerOverlay';
import { useProxyObjectUrl } from './useProxyObjectUrl';
import { ImageMosaicGrid } from './ImageMosaicGrid';

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
 * S58 (D11 / FR-AM-07/09): 단일 이미지는 인라인 max-width 550px(ImageAttachment),
 * 같은 메시지의 이미지가 2장 이상이면 ImageMosaicGrid(수량별 1/2/3/4/5+ 레이아웃)로
 * 묶어 렌더합니다. 비이미지(VIDEO/FILE/audio)는 종전 분기를 그대로 유지합니다.
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
  const sorted = [...attachments].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  // S58 (FR-AM-09): 이미지/비이미지 분리. 이미지 2장 이상이면 모자이크 그리드 한 행으로
  // 묶고, 1장이면 단일 ImageAttachment(550px), 0장이면 이미지 행 없음. 비이미지는 종전
  // 카드 분기(파일/오디오/비디오)를 정렬 순서대로 그대로 렌더합니다.
  const images = sorted.filter((a) => a.kind === 'IMAGE');
  const nonImages = sorted.filter((a) => a.kind !== 'IMAGE');

  return (
    // I (a11y P-03): 첨부 목록에 aria-label 을 부여합니다.
    <ul
      data-testid="message-attachments"
      aria-label="첨부 파일"
      className="mt-[var(--s-2)] space-y-[var(--s-1)]"
    >
      {images.length >= 2 ? (
        // M-01: ImageMosaicGrid 는 <div role="group"> 을 반환하므로 호출부가 <li> 로
        // 감쌉니다(단독 <li> 비유효 HTML 방지). data-testid 는 그리드 내부 group div 가 유지.
        <li data-testid="image-mosaic-grid-item">
          <ImageMosaicGrid images={images} />
        </li>
      ) : (
        images.map((a) => <ImageAttachment key={a.id} attachment={a} />)
      )}
      {nonImages.map((a) => (
        <AttachmentRow key={a.id} attachment={a} />
      ))}
    </ul>
  );
}

function isAudio(att: AttachmentLite): boolean {
  return (att.storedMimeType ?? att.mime).startsWith('audio/');
}

/**
 * S58 부터 AttachmentRow 는 비이미지(VIDEO/FILE/audio)만 받습니다 — 이미지는
 * AttachmentsList 에서 ImageMosaicGrid(2장+) 또는 ImageAttachment(1장)로 직접 라우팅됩니다.
 */
function AttachmentRow({ attachment }: { attachment: AttachmentLite }): JSX.Element {
  const status = attachment.processingStatus ?? 'READY';
  const pending = status === 'PENDING' || status === 'PROCESSING';

  // PENDING/PROCESSING → 비율 예약 스켈레톤(비디오/파일도 후처리 대기 표시).
  if (pending) {
    return (
      <li data-testid={`attachment-skeleton-${attachment.id}`} data-attachment-id={attachment.id}>
        {/* M-03: 로딩 중임을 보조기술에 알립니다(aria-busy). */}
        <div
          role="img"
          aria-label="처리 중"
          aria-busy="true"
          className="qf-skel"
          style={{ width: '240px', height: '160px' }}
        />
      </li>
    );
  }

  // FILE + audio/* → 인라인 오디오 플레이어.
  if (attachment.kind === 'FILE' && isAudio(attachment)) {
    return <AudioAttachment attachment={attachment} />;
  }

  // VIDEO(MVP: 인라인 미재생, 파일 카드) + 그 외 FILE → 다운로드 카드.
  return <FileCard attachment={attachment} />;
}

function ImageAttachment({ attachment }: { attachment: AttachmentLite }): JSX.Element {
  // S58 (FR-AM-25): 단일 이미지도 PENDING/PROCESSING 동안 비율 예약 스켈레톤을 보여준다
  // (이미지는 S58 부터 AttachmentRow 를 거치지 않고 직접 렌더되므로, 종전 AttachmentRow
  // 의 pending 가드를 여기로 옮긴다). width/height 신고가 있으면 aspect-ratio 로 CLS 방지.
  const status = attachment.processingStatus ?? 'READY';
  const pending = status === 'PENDING' || status === 'PROCESSING';
  // reviewer M1: 종착 차단/실패 상태는 객체를 fetch 하면 4xx 가 떨어져 "불러오지 못함"
  // 으로 오인 표시됩니다. fetch 시도 없이 전용 표시로 분기합니다.
  const unavailable = status === 'BLOCKED' || status === 'FAILED';
  // thumbnailKey 있으면 썸네일 변형, 없으면 원본 download.
  const variant: ProxyVariant = attachment.thumbnailKey ? 'thumbnail' : 'download';
  // unavailable(BLOCKED/FAILED)이면 훅을 호출하지 않습니다 — 아래에서 early-return 하므로
  // pending/unavailable 셀은 fetch 를 시도하지 않습니다.
  // H-01 (a11y H-01): altText 빈 문자열("")이면 originalName 폴백(?? 는 null/undefined 만).
  const alt = attachment.altText?.trim() || attachment.originalName;
  // S58 (FR-AM-07): 단일 이미지 인라인 max-width 550px(종전 400px → PRD 정본 정렬).
  const ratioStyle =
    attachment.width && attachment.height
      ? { aspectRatio: `${attachment.width} / ${attachment.height}`, maxWidth: '550px' }
      : { maxWidth: '550px' };

  if (pending) {
    return (
      <li data-testid={`attachment-skeleton-${attachment.id}`} data-attachment-id={attachment.id}>
        {/* M-03: 로딩 중임을 보조기술에 알립니다(aria-busy). */}
        <div
          role="img"
          aria-label="처리 중"
          aria-busy="true"
          className="qf-skel"
          style={{ ...ratioStyle, height: '160px' }}
        />
      </li>
    );
  }

  // BLOCKED/FAILED → fetch 없이 전용 표시(reviewer M1). 비율은 유지해 레이아웃을 보존합니다.
  if (unavailable) {
    const label = status === 'BLOCKED' ? '차단된 파일' : '처리 실패';
    return (
      <li
        data-testid={`attachment-unavailable-${attachment.id}`}
        data-attachment-id={attachment.id}
        data-status={status}
      >
        <div
          role="img"
          aria-label={label}
          className="flex items-center justify-center rounded-[var(--r-md)] border border-border-subtle bg-bg-surface text-[length:var(--fs-13)] text-text-muted"
          style={{ ...ratioStyle, height: '160px' }}
        >
          {label}
        </div>
      </li>
    );
  }

  return (
    <ReadyImageAttachment
      attachment={attachment}
      alt={alt}
      variant={variant}
      ratioStyle={ratioStyle}
    />
  );
}

/**
 * READY 이미지 본체. BLOCKED/FAILED/PENDING 분기 뒤에서만 마운트되므로 useProxyObjectUrl
 * (fetch) 가 차단/실패 객체에 대해 호출되지 않습니다(reviewer M1 — Hooks 규칙상 early-return
 * 후 조건부 훅 호출이 불가하므로 별도 컴포넌트로 분리합니다).
 */
function ReadyImageAttachment({
  attachment,
  alt,
  variant,
  ratioStyle,
}: {
  attachment: AttachmentLite;
  alt: string;
  variant: ProxyVariant;
  ratioStyle: CSSProperties;
}): JSX.Element {
  const { url, error } = useProxyObjectUrl(attachment.id, variant);

  if (error) {
    return (
      <li
        data-testid={`attachment-error-${attachment.id}`}
        // B-05: 로드 실패는 4.1.3 Status Message — role="alert" 로 보조기술에 알립니다.
        role="alert"
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
    // M-03: URL 로딩 스켈레톤도 aria-busy 로 진행 중임을 알립니다.
    <div
      className="qf-skel"
      role="img"
      aria-label="처리 중"
      aria-busy="true"
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
