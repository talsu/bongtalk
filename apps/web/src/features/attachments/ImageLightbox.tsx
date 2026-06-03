import * as RDialog from '@radix-ui/react-dialog';
import {
  useCallback,
  useRef,
  type MutableRefObject,
  type PointerEvent,
  type WheelEvent,
} from 'react';
import type { AttachmentLite } from '@qufox/shared-types';
import { Icon } from '../../design-system/primitives';
import { formatSize } from './formatSize';
import { downloadAttachment, type ProxyVariant } from './attachmentSrc';
import { useProxyObjectUrl } from './useProxyObjectUrl';
import { useImageLightbox } from './useImageLightbox';

/**
 * S59 (D11 / FR-AM-10/11/12) — 이미지 라이트박스(전체화면 오버레이).
 *
 * FR-AM-10: 이미지 클릭 → 전체화면 오버레이. ←/→ 로 같은 메시지 내 READY 이미지를
 *   탐색(순환 없음 — 첫/마지막서 비활성). role="dialog" + aria-modal + sr-only Title.
 *   첫 포커스 = 닫기 버튼. Tab focus trap. Esc/배경클릭 닫기 + 트리거 포커스 복원.
 *   하단 "N / M" + 파일명 + 크기.
 * FR-AM-11: 휠 줌(0.5~3.0 클램프, step 0.15) + 드래그 패닝(pointer) + 키보드 줌
 *   (+/=/-/0). 이미지 교체 시 zoom/translate 리셋. transform-origin: center.
 * FR-AM-12: 다운로드 버튼(downloadAttachment 재사용) + 원본 열기(window.open _blank
 *   noopener,noreferrer). SVG 는 XSS 방어로 원본 열기 버튼 미렌더(다운로드만).
 *
 * 확정 결정(브리프):
 *   - Radix Dialog 직접 사용(qf-modal 고정폭 wrapper Dialog.tsx 미사용). SettingsOverlay
 *     의 RDialog.Root/Portal/Overlay/Content 패턴을 따르며 전체화면 치수로 둡니다.
 *   - objectURL 은 attachmentSrc LRU 가 수명 소유 — 라이트박스가 revoke 하지 않습니다.
 *   - 신규 .css 금지 → Tailwind 인라인 + DS 토큰(var(--*)) + 허용 arbitrary
 *     (z-[9000]/max-w-[95vw] 류·색은 토큰).
 *
 * S59 리뷰 fix-forward:
 *   - B-1 (SC 2.4.3): 외부제어 + Trigger 미사용이라 Radix triggerRef.current=null →
 *     기본 onCloseAutoFocus 가 포커스를 body 로 잃습니다. 부모가 넘긴 triggerRef
 *     (마지막으로 라이트박스를 연 트리거 element)로 닫힐 때 포커스를 명시 복원합니다.
 *   - B-2 (SC 1.4.3): 라이트박스는 항상 어두운 scrim 오버레이 위에 뜨므로 버튼 텍스트/
 *     아이콘 색을 밝은 토큰(--text-onAccent=#FFFFFF·양 테마 동일)으로 명시합니다
 *     (qf-btn--ghost 의 라이트테마 --text-secondary=#3F3A5C 저대비 회피·DS 수정 없이).
 *   - B-3 (SC 2.1.1): 휠 전용 줌은 키보드 불가 → +/=/-/0 키로 줌·리셋을 추가합니다.
 *   - H-1 (SC 4.1.3): 캡션에 aria-live="polite"·aria-atomic 으로 이미지 교체를 통지.
 *   - H-2/H-3 (SC 4.1.2): RDialog.Description(sr-only) 추가 + Content 의 수동 aria-label
 *     제거(자동 aria-labelledby/aria-describedby 만 사용 — 댕글링/중복 제거).
 *
 * 표시 대상은 호출부(AttachmentsList)가 "같은 메시지의 READY 이미지"만 골라 넘깁니다
 * (BLOCKED/FAILED/PENDING 은 제외 — 슬라이드로 들어오지 않습니다).
 */
export interface ImageLightboxProps {
  /** 같은 메시지의 READY 이미지(sortOrder 정렬). 비어 있으면 열지 않습니다. */
  images: AttachmentLite[];
  /** 열림 여부. */
  open: boolean;
  /** 처음 보여줄 이미지 index(클릭한 셀). [0,images.length-1] 로 클램프됩니다. */
  initialIndex: number;
  /** 닫기 요청(Esc/배경클릭/닫기버튼). */
  onClose: () => void;
  /**
   * B-1: 마지막으로 라이트박스를 연 트리거 element 참조. 닫힐 때 포커스를 이 element 로
   * 복원합니다(외부제어 Dialog 라 Radix 자동 복원이 동작하지 않으므로 직접 복원).
   */
  triggerRef?: MutableRefObject<HTMLElement | null>;
}

function isSvg(att: AttachmentLite): boolean {
  // 저장 MIME 우선(서버 magic-byte 재검증값) — 없으면 신고 mime.
  return (att.storedMimeType ?? att.mime) === 'image/svg+xml';
}

export function ImageLightbox({
  images,
  open,
  initialIndex,
  onClose,
  triggerRef,
}: ImageLightboxProps): JSX.Element | null {
  if (images.length === 0) return null;

  return (
    <RDialog.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <RDialog.Portal>
        {/* z-[9000](PRD 명시) + 더 진한 dim 을 위해 scrim 토큰을 겹쳐 깐 backdrop. */}
        <RDialog.Overlay
          data-testid="lightbox-overlay"
          className="fixed inset-0 z-[9000] bg-[color:var(--scrim)]"
        />
        <LightboxContent images={images} initialIndex={initialIndex} triggerRef={triggerRef} />
      </RDialog.Portal>
    </RDialog.Root>
  );
}

/**
 * Dialog.Content 본체. RDialog.Content 가 마운트될 때만 useImageLightbox 가 초기
 * index 를 잡도록 분리합니다(open=false 면 Portal 이 렌더하지 않아 상태가 매 오픈마다
 * 새로 시작 — initialIndex 가 클릭한 셀로 정확히 동기화됩니다).
 */
function LightboxContent({
  images,
  initialIndex,
  triggerRef,
}: {
  images: AttachmentLite[];
  initialIndex: number;
  triggerRef?: MutableRefObject<HTMLElement | null>;
}): JSX.Element {
  const lb = useImageLightbox(images.length, initialIndex);
  const current = images[lb.index] ?? images[0];

  // 드래그 패닝 — pointerdown 시점 좌표/translate 를 기억했다가 move 에서 델타를 더합니다.
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(
    null,
  );

  const onWheel = useCallback(
    (e: WheelEvent<HTMLDivElement>): void => {
      // 배경 스크롤 대신 줌. preventDefault 는 passive 경고를 피하려 비-passive 보장이
      // 어려우므로 호출하지 않고, 상태만 갱신합니다(오버레이는 fixed 라 스크롤 없음).
      lb.zoomBy(e.deltaY);
    },
    [lb],
  );

  const onPointerDown = useCallback(
    (e: PointerEvent<HTMLDivElement>): void => {
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        baseX: lb.translateX,
        baseY: lb.translateY,
      };
      // 포인터 캡처로 컨테이너 밖으로 나가도 move/up 을 계속 받습니다.
      e.currentTarget.setPointerCapture?.(e.pointerId);
    },
    [lb.translateX, lb.translateY],
  );

  const onPointerMove = useCallback(
    (e: PointerEvent<HTMLDivElement>): void => {
      const d = dragRef.current;
      if (!d) return;
      lb.setTranslate(d.baseX + (e.clientX - d.startX), d.baseY + (e.clientY - d.startY));
    },
    [lb],
  );

  const endDrag = useCallback((e: PointerEvent<HTMLDivElement>): void => {
    dragRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  }, []);

  // 키보드: ←/→ 이미지 탐색(순환 없음) + B-3 줌(+/=/-/0). Radix 가 Esc 를 자체 처리합니다.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>): void => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        lb.prev();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        lb.next();
      } else if (e.key === '+' || e.key === '=') {
        // B-3: 키보드 확대(휠 업과 동일 방향 — deltaY<0).
        e.preventDefault();
        lb.zoomBy(-1);
      } else if (e.key === '-') {
        // B-3: 키보드 축소(휠 다운과 동일 — deltaY>0).
        e.preventDefault();
        lb.zoomBy(1);
      } else if (e.key === '0') {
        // B-3: 키보드 줌 리셋(zoom=1, translate=0).
        e.preventDefault();
        lb.resetTransform();
      }
    },
    [lb],
  );

  const svg = isSvg(current);

  return (
    <RDialog.Content
      data-testid="lightbox"
      // FR-AM-10: 다이얼로그 시맨틱. Radix 는 role=dialog + aria-labelledby(Title) +
      // aria-describedby(Description)를 자동 부여합니다. aria-modal 은 모달리티를
      // 명시하려 PRD 요구대로 둡니다. H-3: 수동 aria-label 은 제거하고 Title 자동
      // 연결(aria-labelledby)만 씁니다.
      aria-modal="true"
      onKeyDown={onKeyDown}
      // B-1: 외부제어 Dialog 라 Radix 의 trigger 포커스 복원이 동작하지 않습니다
      // (triggerRef.current=null). 기본 preventDefault 후 마지막으로 연 트리거로 직접 복원.
      onCloseAutoFocus={(e) => {
        e.preventDefault();
        triggerRef?.current?.focus();
      }}
      className="fixed inset-0 z-[9000] flex flex-col items-center justify-center outline-none"
    >
      <RDialog.Title className="sr-only">이미지 뷰어</RDialog.Title>
      {/* H-2: Description 으로 조작 안내를 제공해 Radix 자동 aria-describedby 댕글링을 제거. */}
      <RDialog.Description className="sr-only">
        방향키로 이미지를 탐색하고, +/- 로 확대·축소, 0 으로 원래 크기, Esc 로 닫습니다.
      </RDialog.Description>

      {/* 툴바: 다운로드 / 원본 열기(SVG 제외) / 닫기. 닫기가 첫 포커스가 되도록
          autoFocus 로 닫기 버튼을 명시합니다. */}
      <div
        data-testid="lightbox-toolbar"
        className="absolute right-[var(--s-4)] top-[var(--s-4)] flex items-center gap-[var(--s-2)]"
      >
        <button
          type="button"
          data-testid="lightbox-download"
          aria-label={`${current.originalName} 다운로드`}
          onClick={() => void downloadAttachment(current.id, current.originalName).catch(() => {})}
          className="qf-btn qf-btn--secondary qf-btn--sm inline-flex items-center gap-[var(--s-1)] text-[color:var(--text-onAccent)]"
        >
          <Icon name="download" size="sm" />
        </button>
        {/* FR-AM-12: SVG 는 원본 열기 미렌더(XSS 방어 — 다운로드만). */}
        {!svg ? <LightboxOpenOriginalButton attachment={current} /> : null}
        {/* 첫 포커스 = 닫기 버튼(FR-AM-10). Radix 의 초기 autoFocus 를 막지 않도록
            autoFocus 를 둡니다. B-2: 어두운 오버레이 위 대비 확보를 위해 ghost color
            의존을 끊고 밝은 토큰으로 override(hover 시 반투명 흰 배경). */}
        <RDialog.Close asChild>
          <button
            type="button"
            data-testid="lightbox-close"
            aria-label="이미지 뷰어 닫기"
            autoFocus
            className="qf-btn qf-btn--ghost qf-btn--sm inline-flex items-center gap-[var(--s-1)] text-[color:var(--text-onAccent)] hover:bg-white/10"
          >
            <Icon name="x" size="md" />
          </button>
        </RDialog.Close>
      </div>

      {/* 좌측 이전 버튼 — 첫 장이면 비활성(순환 없음). B-2: 밝은 토큰 + 반투명 hover. */}
      <button
        type="button"
        data-testid="lightbox-prev"
        aria-label="이전 이미지"
        disabled={lb.isFirst}
        onClick={() => lb.prev()}
        className="absolute left-[var(--s-4)] top-1/2 -translate-y-1/2 qf-btn qf-btn--ghost inline-flex items-center text-[color:var(--text-onAccent)] hover:bg-white/10 disabled:opacity-40"
      >
        <Icon name="arrow-left" size="md" />
      </button>

      {/* 이미지 컨테이너: 휠 줌 + 드래그 패닝. 배경 클릭 닫기를 위해 컨테이너 밖
          오버레이 클릭은 Radix outside-click 로 닫힙니다(이미지 위 클릭은 닫지 않음). */}
      <div
        data-testid="lightbox-stage"
        className="flex max-h-[90vh] max-w-[95vw] items-center justify-center overflow-hidden"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <LightboxImage
          attachment={current}
          zoom={lb.zoom}
          translateX={lb.translateX}
          translateY={lb.translateY}
        />
      </div>

      {/* 우측 다음 버튼 — 마지막 장이면 비활성. B-2: 밝은 토큰 + 반투명 hover. */}
      <button
        type="button"
        data-testid="lightbox-next"
        aria-label="다음 이미지"
        disabled={lb.isLast}
        onClick={() => lb.next()}
        className="absolute right-[var(--s-4)] top-1/2 -translate-y-1/2 qf-btn qf-btn--ghost inline-flex items-center text-[color:var(--text-onAccent)] hover:bg-white/10 disabled:opacity-40"
      >
        <Icon name="arrow-right" size="md" />
      </button>

      {/* 하단 캡션: "N / M" + 파일명 + 크기(FR-AM-10). H-1: 이미지 교체를 SR 에 통지. */}
      <div
        data-testid="lightbox-caption"
        aria-live="polite"
        aria-atomic="true"
        className="absolute bottom-[var(--s-4)] left-1/2 flex -translate-x-1/2 items-center gap-[var(--s-2)] rounded-[var(--r-md)] bg-[color:var(--scrim)] px-[var(--s-3)] py-[var(--s-1)] text-[length:var(--fs-13)] text-[color:var(--text-onAccent)]"
      >
        <span data-testid="lightbox-counter">
          {lb.index + 1} / {images.length}
        </span>
        <span className="truncate" title={current.originalName}>
          {current.originalName}
        </span>
        <span className="text-[color:var(--text-onAccent)] opacity-80">
          {formatSize(current.sizeBytes)}
        </span>
      </div>
    </RDialog.Content>
  );
}

/**
 * 원본 열기 버튼. objectURL 을 LRU 에서 받아 새 탭으로 엽니다(noopener,noreferrer).
 * SVG 는 호출부에서 렌더하지 않으므로 여기 도달하지 않습니다(XSS 방어).
 */
function LightboxOpenOriginalButton({ attachment }: { attachment: AttachmentLite }): JSX.Element {
  // 원본 열기는 항상 download 변형(원본 바이트)을 사용합니다.
  const { url } = useProxyObjectUrl(attachment.id, 'download');
  return (
    <button
      type="button"
      data-testid="lightbox-open-original"
      // M-2: 다운로드와 일관되게 파일명을 포함한 aria-label 을 부여합니다.
      aria-label={`${attachment.originalName} 원본 열기`}
      disabled={!url}
      onClick={() => {
        if (url) window.open(url, '_blank', 'noopener,noreferrer');
      }}
      // B-2: 어두운 오버레이 위 대비 확보 — 밝은 토큰 + 반투명 hover.
      className="qf-btn qf-btn--ghost qf-btn--sm inline-flex items-center gap-[var(--s-1)] text-[color:var(--text-onAccent)] hover:bg-white/10"
    >
      <Icon name="external" size="md" />
    </button>
  );
}

/**
 * 현재 이미지 본체. objectURL 을 인증 fetch(LRU 캐시 hit 시 즉시)로 받아 표시하며,
 * zoom/translate 를 transform 으로 적용합니다(transform-origin: center).
 */
function LightboxImage({
  attachment,
  zoom,
  translateX,
  translateY,
}: {
  attachment: AttachmentLite;
  zoom: number;
  translateX: number;
  translateY: number;
}): JSX.Element {
  // 라이트박스는 원본 화질을 보여줍니다 — thumbnail 이 아니라 download(원본).
  const variant: ProxyVariant = 'download';
  const { url, error } = useProxyObjectUrl(attachment.id, variant);
  // M-3: originalName 이 빈 경우까지 방어해 alt 가 빈 문자열이 되지 않게 합니다(SC 1.1.1).
  const alt = attachment.altText?.trim() || attachment.originalName?.trim() || '이미지';

  if (error) {
    return (
      <div
        data-testid="lightbox-error"
        role="alert"
        className="text-[length:var(--fs-15)] text-[color:var(--danger-400)]"
      >
        이미지를 불러오지 못했습니다.
      </div>
    );
  }

  if (!url) {
    return (
      <div
        data-testid="lightbox-loading"
        role="img"
        aria-label="처리 중"
        aria-busy="true"
        className="qf-skel"
        style={{ width: '320px', height: '240px' }}
      />
    );
  }

  return (
    <img
      data-testid="lightbox-image"
      src={url}
      alt={alt}
      // FR-AM-11: zoom*scale + 패닝 translate. transform-origin: center(중앙 기준).
      // ui-designer MINOR-2: cursor 는 style 이 아니라 조건부 className(grab/default)으로.
      style={{
        transform: `scale(${zoom}) translate(${translateX}px, ${translateY}px)`,
        transformOrigin: 'center',
      }}
      className={`block max-h-[90vh] max-w-[95vw] select-none object-contain ${
        zoom > 1 ? 'cursor-grab' : 'cursor-default'
      }`}
      draggable={false}
    />
  );
}
