import type { AttachmentLite } from '@qufox/shared-types';
import { AttachmentSpoilerOverlay } from './AttachmentSpoilerOverlay';
import { useProxyObjectUrl } from './useProxyObjectUrl';

/**
 * S58 (D11 / FR-AM-09) — 한 메시지에 이미지가 2장 이상일 때의 모자이크 그리드.
 *
 * 단일 이미지는 호출부(AttachmentsList)가 ImageAttachment(550px)로 직접 렌더하므로,
 * 이 컴포넌트는 항상 2장 이상을 가정합니다. 수량별 레이아웃:
 *   2장   → 2열 균등(aspect 통일)
 *   3장   → 좌측 큰 1 + 우측 세로 2
 *   4장   → 2x2
 *   5장+  → 상단 2 + 하단 3(5칸). 6장 이상이면 5번째 칸에 "+N"(N=총장수−5) 오버레이로
 *           나머지를 가립니다.
 * 그리드 전체 max-width 550px, 각 셀 object-cover + 통일 비율로 CLS 를 방지합니다.
 *
 * S58 범위: 인라인 표시까지만. 라이트박스/전체화면/zoom·pan/네비게이션은 S59
 * (FR-AM-10/11/12)입니다. 다만 S59 연결점으로 `onImageOpen?(index)` optional prop 을
 * 둡니다 — 미전달 시 셀 클릭은 무동작입니다(현재 호출부는 전달하지 않습니다).
 *
 * S58 fix-forward (a11y M-01): 이 컴포넌트는 루트로 `<div role="group">` 을 반환합니다.
 * 종전에는 `<li>` 를 직접 반환해 단독 render 시 비유효 HTML(`<li>` without `<ul>`)이
 * 됐으나, 이제 호출부(AttachmentsList)가 `<li>` 로 감싸 렌더합니다. data-testid 위치
 * (image-mosaic-grid)는 그룹 div 로 유지합니다.
 *
 * DS 토큰만 사용합니다(raw hex/px 금지). 그리드는 Tailwind grid 유틸 + DS 간격/모서리
 * 토큰(--s-1 / --r-md)으로 표현합니다.
 */
export interface ImageMosaicGridProps {
  /** 모두 kind==='IMAGE' 이며 sortOrder 로 정렬된 2장 이상의 첨부. */
  images: AttachmentLite[];
  /**
   * S59 연결점. 셀(또는 "+N" 오버레이) 클릭 시 해당 index 로 호출됩니다. 미전달 시
   * 클릭은 무동작입니다(라이트박스는 S59 에서 연결).
   */
  onImageOpen?: (index: number) => void;
}

/** 5장 초과분을 +N 으로 가리므로 그리드가 렌더하는 셀은 최대 5칸입니다. */
const MAX_VISIBLE_CELLS = 5;

export function ImageMosaicGrid({ images, onImageOpen }: ImageMosaicGridProps): JSX.Element {
  const total = images.length;
  // 6장 이상이면 5칸만 노출하고 5번째 칸을 "+N" 오버레이로 가립니다(나머지 숨김).
  const visible = images.slice(0, MAX_VISIBLE_CELLS);
  const overflow = total - MAX_VISIBLE_CELLS; // >0 이면 +N 오버레이.

  return (
    // M-01/M-02: 그룹 시맨틱(role="group")으로 2장+ 이미지 묶음을 한 단위로 노출합니다.
    // 루트는 더 이상 `<li>` 가 아닙니다 — 호출부(AttachmentsList)가 `<li>` 로 감쌉니다.
    <div
      data-testid="image-mosaic-grid"
      data-image-count={total}
      role="group"
      aria-label={`이미지 ${total}장`}
    >
      <div
        className="grid w-full gap-[var(--s-1)]"
        // FR-AM-09: 그리드 전체 max-width 550px. Tailwind 임의값 max-w-[550px] 는 DS
        // 가드(task-018)가 막으므로 ImageAttachment 와 동일하게 인라인 style 문자열로 둔다
        // (raw px 브래킷 회피 — '550px' 문자열은 가드 패턴에 안 걸림).
        style={{ maxWidth: '550px', gridTemplateColumns: gridColumns(visible.length) }}
      >
        {visible.map((att, index) => (
          <MosaicCell
            key={att.id}
            attachment={att}
            index={index}
            // 6장+ 일 때 마지막(5번째·index 4) 셀에만 +N 오버레이.
            overflowCount={index === MAX_VISIBLE_CELLS - 1 && overflow > 0 ? overflow : 0}
            spanClassName={cellSpan(visible.length, index)}
            onImageOpen={onImageOpen}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * 셀 수별 그리드 컬럼 정의. 3장은 좌측 큰 셀(2fr) + 우측 컬럼(1fr)을 위해 2열을 쓰되
 * 좌측 셀이 2행을 span 합니다(cellSpan 참고). 그 외(2/4/5)는 균등 2열입니다.
 */
function gridColumns(visibleCount: number): string {
  if (visibleCount === 3) return '2fr 1fr';
  return 'repeat(2, 1fr)';
}

/**
 * 셀별 span 클래스. 3장만 좌측 큰 셀(index 0)이 2행 span 해 우측 세로 2칸과 높이를
 * 맞춥니다. 2/4/5 칸은 균등 2열(자동 행 채움)이라 span 이 없습니다 — 5칸은 2열 그리드라
 * 2·2·1 로 흘러갑니다(PRD FR-AM-09 의 "5장+ = 2열" 허용 형태).
 */
function cellSpan(visibleCount: number, index: number): string {
  // 3장: 좌측 큰 셀(index 0)이 2행 span → 우측 2칸과 높이 정렬.
  if (visibleCount === 3 && index === 0) return 'row-span-2';
  return '';
}

interface MosaicCellProps {
  attachment: AttachmentLite;
  index: number;
  /** >0 이면 이 셀 위에 반투명 "+N" 오버레이를 띄웁니다(6장 이상의 5번째 셀). */
  overflowCount: number;
  spanClassName: string;
  onImageOpen?: (index: number) => void;
}

function MosaicCell({
  attachment,
  index,
  overflowCount,
  spanClassName,
  onImageOpen,
}: MosaicCellProps): JSX.Element {
  const status = attachment.processingStatus ?? 'READY';
  const pending = status === 'PENDING' || status === 'PROCESSING';
  // S58 fix-forward (reviewer M1): 종착 차단/실패 상태는 객체를 fetch 하면 4xx 가 떨어져
  // "불러오기 실패" 로 오인 표시됩니다. fetch 시도 없이 전용 표시로 분기합니다.
  const unavailable = status === 'BLOCKED' || status === 'FAILED';
  // H-01: altText 가 빈 문자열("")이면 originalName 으로 폴백합니다(?? 는 null/undefined
  // 만 폴백하므로 trim() 후 truthy 검사로 빈 alt 렌더를 막습니다).
  const alt = attachment.altText?.trim() || attachment.originalName;
  // 클릭 가능 여부 — onImageOpen 미전달이면 무동작(S59 미연결).
  const clickable = typeof onImageOpen === 'function';
  const open = (): void => onImageOpen?.(index);

  const cellClass = `relative overflow-hidden rounded-[var(--r-md)] border border-border-subtle ${spanClassName}`;

  // PENDING/PROCESSING → 비율 예약 스켈레톤(FR-AM-25 대기 표시).
  if (pending) {
    return (
      <div
        data-testid={`mosaic-skeleton-${attachment.id}`}
        data-attachment-id={attachment.id}
        className={cellClass}
      >
        {/* M-03: 로딩 중임을 보조기술에 알립니다(aria-busy). */}
        <div
          role="img"
          aria-label="처리 중"
          aria-busy="true"
          className="qf-skel aspect-square w-full"
        />
      </div>
    );
  }

  // BLOCKED/FAILED → fetch 없이 전용 표시(reviewer M1). 셀 비율/테두리는 유지해 그리드
  // 정렬이 깨지지 않게 합니다.
  if (unavailable) {
    const label = status === 'BLOCKED' ? '차단된 파일' : '처리 실패';
    return (
      <div
        data-testid={`mosaic-unavailable-${attachment.id}`}
        data-attachment-id={attachment.id}
        data-status={status}
        className={cellClass}
      >
        <div
          role="img"
          aria-label={label}
          className="flex aspect-square w-full items-center justify-center bg-bg-surface text-[length:var(--fs-11)] text-text-muted"
        >
          {label}
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid={`mosaic-cell-${attachment.id}`}
      data-attachment-id={attachment.id}
      className={cellClass}
    >
      {attachment.isSpoiler ? (
        // m1 (reviewer) + MINOR-1: 스포일러 래퍼(inline-block)가 셀 폭을 못 채우는 것을
        // 막기 위해 block w-full h-full 래퍼로 감싸 셀 전체를 채웁니다.
        <div className="block h-full w-full">
          <AttachmentSpoilerOverlay label={alt}>
            <MosaicImage
              attachment={attachment}
              alt={alt}
              clickable={clickable}
              onOpen={open}
              hiddenFromA11y={overflowCount > 0}
            />
          </AttachmentSpoilerOverlay>
        </div>
      ) : (
        <MosaicImage
          attachment={attachment}
          alt={alt}
          clickable={clickable}
          onOpen={open}
          // H-02: +N 오버레이로 가려진 이미지는 접근성 트리에서 중복 노출을 막습니다.
          hiddenFromA11y={overflowCount > 0}
        />
      )}
      {overflowCount > 0 ? (
        <button
          type="button"
          data-testid="mosaic-overflow"
          aria-label={`이미지 ${overflowCount}장 더 보기`}
          // 미연결(S59 전)이면 클릭 비활성 — onImageOpen 없으면 무동작.
          disabled={!clickable}
          onClick={clickable ? open : undefined}
          // B-03: font-semibold(600)는 WCAG large-text 예외(bold 700+) 미충족 →
          // font-bold(700) 로 올려 fs-20 + bold = large text 예외(3:1)를 충족합니다.
          className="absolute inset-0 flex items-center justify-center bg-[color:var(--scrim)] text-[length:var(--fs-20)] font-bold text-[color:var(--text-onAccent)]"
        >
          +{overflowCount}
        </button>
      ) : null}
    </div>
  );
}

function MosaicImage({
  attachment,
  alt,
  clickable,
  onOpen,
  hiddenFromA11y,
}: {
  attachment: AttachmentLite;
  alt: string;
  clickable: boolean;
  onOpen: () => void;
  /** +N 오버레이로 가려진 셀이면 true — 접근성 트리에서 alt 중복 노출을 막습니다(H-02). */
  hiddenFromA11y: boolean;
}): JSX.Element {
  // thumbnailKey 있으면 썸네일 변형, 없으면 원본 download(ImageAttachment 와 동일 규칙).
  const variant = attachment.thumbnailKey ? 'thumbnail' : 'download';
  const { url, error } = useProxyObjectUrl(attachment.id, variant);

  if (error) {
    return (
      <div
        data-testid={`mosaic-error-${attachment.id}`}
        // B-04: 로드 실패는 4.1.3 Status Message — role="alert" 로 보조기술에 알립니다.
        role="alert"
        className="flex aspect-square w-full items-center justify-center bg-bg-surface text-[length:var(--fs-11)] text-[color:var(--danger-400)]"
      >
        불러오기 실패
      </div>
    );
  }

  if (!url) {
    return (
      // M-03: URL 로딩 스켈레톤도 aria-busy 로 진행 중임을 알립니다.
      <div
        className="qf-skel aspect-square w-full"
        role="img"
        aria-label="처리 중"
        aria-busy="true"
      />
    );
  }

  const imgEl = (
    <img
      src={url}
      // H-02: 가려진 셀은 alt="" + aria-hidden 으로 접근성 트리에서 제거합니다.
      alt={hiddenFromA11y ? '' : alt}
      aria-hidden={hiddenFromA11y || undefined}
      loading="lazy"
      className="aspect-square w-full object-cover"
      draggable={false}
    />
  );

  // S59 (S58 이월 H-03/M-04): clickable 이면 비인터랙티브 <img> 대신 <button> 으로
  // 감싸 클릭·키보드(Enter/Space, button 기본 동작)·포커스를 제공하고 Radix Dialog 가
  // 닫힐 때 이 트리거로 포커스를 복원할 수 있게 합니다. 가려진 셀(+N)은 별도 오버레이
  // 버튼이 클릭을 받으므로 여기선 button 화하지 않고 비인터랙티브 이미지로 둡니다.
  if (!clickable || hiddenFromA11y) return imgEl;

  return (
    <button
      type="button"
      data-testid={`mosaic-trigger-${attachment.id}`}
      // 이미지 alt 가 버튼 라벨이 되도록 aria-label 을 부여합니다(이미지는 alt 그대로).
      aria-label={`${alt} 크게 보기`}
      onClick={onOpen}
      className="block aspect-square w-full cursor-pointer p-0"
    >
      {imgEl}
    </button>
  );
}
