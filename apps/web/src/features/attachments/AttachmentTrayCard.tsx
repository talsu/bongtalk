import { useState } from 'react';
import { Icon } from '../../design-system/primitives';
import { cn } from '../../lib/cn';
import { formatSize } from './formatSize';
import type { TrayItem } from './useAttachmentUpload';

/**
 * S56 (D11 / FR-AM-02/22) — 전송 전 첨부 미리보기 트레이의 카드 1개.
 *
 * 썸네일(이미지 objectURL) 또는 파일 아이콘 + 파일명/크기. 액션:
 *   - alt 텍스트 입력(연필 토글 → 인라인 input)
 *   - 스포일러 토글(눈 · aria-pressed)
 *   - 개별 제거(X)
 *   - 실패 시 재시도
 * 상태별: uploading(진행률 바) / ready / failed(danger 테두리).
 *
 * raw hex/px/shadow 금지 — DS 토큰(var(--*)) + 기존 qf-* 만 사용합니다.
 */
export function AttachmentTrayCard({
  item,
  onRemove,
  onRetry,
  onAltChange,
  onToggleSpoiler,
}: {
  item: TrayItem;
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
  onAltChange: (id: string, alt: string) => void;
  onToggleSpoiler: (id: string) => void;
}): JSX.Element {
  const [altOpen, setAltOpen] = useState(false);
  const isImage = item.kind === 'IMAGE';
  const failed = item.status === 'failed';
  const uploading = item.status === 'uploading';

  return (
    <li
      data-testid={`tray-card-${item.id}`}
      data-status={item.status}
      className={cn(
        'flex w-52 flex-col gap-[var(--s-2)] rounded-[var(--r-md)] border p-[var(--s-2)]',
        failed
          ? 'border-[color:var(--danger-400)] bg-bg-surface'
          : 'border-border-subtle bg-bg-surface',
      )}
    >
      {/* 썸네일 / 아이콘 영역 */}
      <div className="relative flex h-24 items-center justify-center overflow-hidden rounded-[var(--r-sm)] bg-[color:var(--bg-elevated)]">
        {isImage && item.previewUrl ? (
          <img
            src={item.previewUrl}
            alt={item.altText || item.file.name}
            className={cn('h-full w-full object-cover', item.isSpoiler ? 'blur-md' : null)}
          />
        ) : (
          <Icon
            name={item.kind === 'VIDEO' ? 'video' : 'file'}
            size="xl"
            className="text-text-muted"
          />
        )}
        {/* 제거 버튼(우상단) */}
        <button
          type="button"
          data-testid={`tray-remove-${item.id}`}
          aria-label={`${item.file.name} 첨부 제거`}
          onClick={() => onRemove(item.id)}
          className="qf-row-iconbtn absolute right-[var(--s-1)] top-[var(--s-1)] bg-bg-surface"
        >
          <Icon name="x" size="sm" />
        </button>
      </div>

      {/* 파일명 + 크기 */}
      <div className="min-w-0">
        <div
          className="truncate text-[length:var(--fs-13)] text-[color:var(--text)]"
          title={item.file.name}
        >
          {item.file.name}
        </div>
        <div className="text-[length:var(--fs-11)] text-text-muted">
          {formatSize(item.file.size)}
        </div>
      </div>

      {/* 상태 영역 */}
      {uploading ? (
        <div
          role="progressbar"
          aria-valuenow={item.progress}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${item.file.name} 업로드 진행률`}
          data-testid={`tray-progress-${item.id}`}
          className="h-[var(--s-1)] overflow-hidden rounded-[var(--r-sm)] bg-[color:var(--bg-elevated)]"
        >
          <div
            className="h-full bg-[color:var(--accent)] transition-[width]"
            style={{ width: `${item.progress}%` }}
          />
        </div>
      ) : null}
      {failed ? (
        <div className="flex items-center justify-between gap-[var(--s-2)]">
          <span className="text-[length:var(--fs-11)] text-[color:var(--danger-400)]">
            업로드 실패
          </span>
          <button
            type="button"
            data-testid={`tray-retry-${item.id}`}
            aria-label={`${item.file.name} 업로드 재시도`}
            onClick={() => onRetry(item.id)}
            className="qf-btn qf-btn--ghost qf-btn--sm"
          >
            재시도
          </button>
        </div>
      ) : null}

      {/* 액션: 스포일러 / alt(이미지·비디오만) */}
      {!failed ? (
        <div className="flex items-center gap-[var(--s-1)]">
          <button
            type="button"
            data-testid={`tray-spoiler-${item.id}`}
            aria-pressed={item.isSpoiler}
            aria-label={`${item.file.name} 스포일러 ${item.isSpoiler ? '해제' : '설정'}`}
            onClick={() => onToggleSpoiler(item.id)}
            className={cn('qf-row-iconbtn', item.isSpoiler ? 'text-accent' : null)}
          >
            <Icon name={item.isSpoiler ? 'eye-off' : 'eye'} size="sm" />
          </button>
          {isImage || item.kind === 'VIDEO' ? (
            <button
              type="button"
              data-testid={`tray-alt-toggle-${item.id}`}
              aria-pressed={altOpen}
              aria-label={`${item.file.name} 대체 텍스트 ${altOpen ? '닫기' : '추가'}`}
              onClick={() => setAltOpen((v) => !v)}
              className={cn('qf-row-iconbtn', item.altText ? 'text-accent' : null)}
            >
              <Icon name="edit" size="sm" />
            </button>
          ) : null}
          {item.altText && !altOpen ? <span className="qf-badge qf-badge--accent">ALT</span> : null}
        </div>
      ) : null}

      {altOpen ? (
        <input
          type="text"
          data-testid={`tray-alt-input-${item.id}`}
          value={item.altText}
          maxLength={2000}
          aria-label={`${item.file.name} 대체 텍스트`}
          placeholder="대체 텍스트(접근성)"
          onChange={(e) => onAltChange(item.id, e.target.value)}
          className="w-full rounded-[var(--r-sm)] border border-border-subtle bg-bg-input px-[var(--s-2)] py-[var(--s-1)] text-[length:var(--fs-11)] text-[color:var(--text)] outline-none placeholder:text-text-muted"
        />
      ) : null}
    </li>
  );
}
