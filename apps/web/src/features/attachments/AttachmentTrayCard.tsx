import { memo, useEffect, useRef, useState } from 'react';
import { Icon } from '../../design-system/primitives';
import { cn } from '../../lib/cn';
import { formatSize } from './formatSize';
import type { TrayItem, TrayItemStatus } from './useAttachmentUpload';

/**
 * S56 (D11 / FR-AM-02/22) — 전송 전 첨부 미리보기 트레이의 카드 1개.
 *
 * 썸네일(이미지 objectURL) 또는 파일 아이콘 + 파일명/크기. 액션:
 *   - alt 텍스트 입력(연필 토글 → 인라인 input)
 *   - 스포일러 토글(눈 · aria-pressed — 트레이 토글은 양방향이라 pressed 가 적합)
 *   - 개별 제거(X)
 *   - 실패 시 재시도
 * 상태별: uploading(진행률 바) / ready / failed(danger 테두리).
 *
 * S56 fix-forward:
 *   - (perf serious) React.memo 로 감싸 진행률 patch 가 다른 카드 리렌더를
 *     유발하지 않게 한다.
 *   - (a11y B-01/B-04) 액션 버튼을 18px qf-row-iconbtn 대신 28px
 *     qf-btn qf-btn--ghost qf-btn--icon qf-btn--sm 로 교체(터치 타깃 + focus-visible
 *     클리핑 회피). 썸네일 컨테이너의 overflow-hidden 도 제거해 focus ring 이
 *     잘리지 않게 한다.
 *   - (a11y B-02) uploading→ready/failed 전환을 sr-only aria-live 로 통지.
 *
 * raw hex/px/shadow 금지 — DS 토큰(var(--*)) + 기존 qf-* 만 사용합니다.
 */
function AttachmentTrayCardImpl({
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
  // S57 (FR-AM-24): 전송 상태 기계. sending = 낙관적 전송 진행 중(편집 잠금),
  // confirmed = 서버 확정(미리보기를 프록시 URL 로 교체). 둘 다 진행률/실패 UI 미노출.
  const sending = item.status === 'sending';
  const confirmed = item.status === 'confirmed';
  // sending/confirmed 동안에는 액션(스포일러/alt/제거/재시도)을 잠근다 —
  // 전송 도중 메타 변경/제거가 complete 와 race 하지 않게 한다.
  const locked = sending || confirmed;

  // B-02: uploading → ready/failed 전환을 스크린리더에 통지. 종전엔 진행률
  // progressbar 만 있고 완료/실패는 무음이었다. 상태가 실제로 바뀐 경우에만
  // 메시지를 갱신해 SR 이 변경을 감지하게 한다.
  const [liveMsg, setLiveMsg] = useState('');
  const prevStatusRef = useRef<TrayItemStatus>(item.status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    if (prev !== item.status) {
      if (item.status === 'ready') setLiveMsg(`${item.file.name} 업로드 완료`);
      else if (item.status === 'failed') setLiveMsg(`${item.file.name} 업로드 실패`);
      // S57 (FR-AM-24 · a11y): 전송 진행/확정 전환을 스크린리더에 통지.
      else if (item.status === 'sending') setLiveMsg(`${item.file.name} 전송 중`);
      else if (item.status === 'confirmed') setLiveMsg(`${item.file.name} 전송 완료`);
      else setLiveMsg('');
      prevStatusRef.current = item.status;
    }
  }, [item.status, item.file.name]);

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
      {/* B-02: 업로드 완료/실패 sr-only 통지(항상 마운트 — 무음 시 빈 문자열). */}
      <span className="sr-only" aria-live="polite" data-testid={`tray-live-${item.id}`}>
        {liveMsg}
      </span>

      {/* 썸네일 / 아이콘 영역. B-04: overflow-hidden 제거 — 제거 버튼 focus ring 이
          썸네일 모서리에 잘리지 않게 한다. 썸네일 자체 라운딩은 img 에 둔다. */}
      <div className="relative flex h-24 items-center justify-center rounded-[var(--r-sm)] bg-[color:var(--bg-elevated)]">
        {isImage && item.previewUrl ? (
          <img
            src={item.previewUrl}
            alt={item.altText || item.file.name}
            className={cn(
              'h-full w-full rounded-[var(--r-sm)] object-cover',
              item.isSpoiler ? 'blur-md' : null,
            )}
          />
        ) : (
          <Icon
            name={item.kind === 'VIDEO' ? 'video' : 'file'}
            size="xl"
            className="text-text-muted"
          />
        )}
        {/* 제거 버튼(우상단). B-01: 28px qf-btn--icon--sm(터치 ≥24px + focus-visible).
            S57: 전송 중/확정 후에는 제거를 잠근다(complete 와의 race 방지). */}
        {!locked ? (
          <button
            type="button"
            data-testid={`tray-remove-${item.id}`}
            aria-label={`${item.file.name} 첨부 제거`}
            onClick={() => onRemove(item.id)}
            className="qf-btn qf-btn--ghost qf-btn--icon qf-btn--sm absolute right-[var(--s-1)] top-[var(--s-1)] bg-bg-surface"
          >
            <Icon name="x" size="sm" />
          </button>
        ) : null}
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

      {/* S57 (FR-AM-24): 전송 진행/확정 상태 표시(액션 대신). */}
      {sending ? (
        <div
          data-testid={`tray-sending-${item.id}`}
          className="flex items-center gap-[var(--s-1)] text-[length:var(--fs-11)] text-text-muted"
        >
          <Icon name="loading" size="sm" className="animate-spin" />
          전송 중…
        </div>
      ) : null}
      {confirmed ? (
        <div
          data-testid={`tray-confirmed-${item.id}`}
          className="flex items-center gap-[var(--s-1)] text-[length:var(--fs-11)] text-[color:var(--accent)]"
        >
          <Icon name="check" size="sm" />
          전송 완료
        </div>
      ) : null}

      {/* 액션: 스포일러 / alt(이미지·비디오만). B-01/B-04: 28px qf-btn--icon--sm.
          S57: 전송 중/확정 후에는 메타 편집을 잠근다. */}
      {!failed && !locked ? (
        <div className="flex items-center gap-[var(--s-1)]">
          <button
            type="button"
            data-testid={`tray-spoiler-${item.id}`}
            aria-pressed={item.isSpoiler}
            aria-label={`${item.file.name} 스포일러 ${item.isSpoiler ? '해제' : '설정'}`}
            onClick={() => onToggleSpoiler(item.id)}
            className={cn(
              'qf-btn qf-btn--ghost qf-btn--icon qf-btn--sm',
              item.isSpoiler ? 'text-accent' : null,
            )}
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
              className={cn(
                'qf-btn qf-btn--ghost qf-btn--icon qf-btn--sm',
                item.altText ? 'text-accent' : null,
              )}
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

/**
 * perf serious(진행률 setState 폭주): 트레이 1장의 진행률 patch 가 형제 카드까지
 * 리렌더하지 않도록 React.memo 로 감싼다. props(item 참조)가 바뀐 카드만 리렌더된다.
 */
export const AttachmentTrayCard = memo(AttachmentTrayCardImpl);
