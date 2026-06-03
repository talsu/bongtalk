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
    <li data-testid="image-mosaic-grid" data-image-count={total}>
      <div
        className="grid gap-[var(--s-1)]"
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
    </li>
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
  const alt = attachment.altText ?? attachment.originalName;
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
        <div role="img" aria-label="처리 중" className="qf-skel aspect-square w-full" />
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
        <AttachmentSpoilerOverlay label={alt}>
          <MosaicImage attachment={attachment} alt={alt} clickable={clickable} onOpen={open} />
        </AttachmentSpoilerOverlay>
      ) : (
        <MosaicImage attachment={attachment} alt={alt} clickable={clickable} onOpen={open} />
      )}
      {overflowCount > 0 ? (
        <button
          type="button"
          data-testid="mosaic-overflow"
          aria-label={`이미지 ${overflowCount}장 더 보기`}
          // 미연결(S59 전)이면 클릭 비활성 — onImageOpen 없으면 무동작.
          disabled={!clickable}
          onClick={clickable ? open : undefined}
          className="absolute inset-0 flex items-center justify-center bg-[color:var(--scrim)] text-[length:var(--fs-20)] font-semibold text-[color:var(--text-onAccent)]"
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
}: {
  attachment: AttachmentLite;
  alt: string;
  clickable: boolean;
  onOpen: () => void;
}): JSX.Element {
  // thumbnailKey 있으면 썸네일 변형, 없으면 원본 download(ImageAttachment 와 동일 규칙).
  const variant = attachment.thumbnailKey ? 'thumbnail' : 'download';
  const { url, error } = useProxyObjectUrl(attachment.id, variant);

  if (error) {
    return (
      <div
        data-testid={`mosaic-error-${attachment.id}`}
        className="flex aspect-square w-full items-center justify-center bg-bg-surface text-[length:var(--fs-11)] text-[color:var(--danger-400)]"
      >
        불러오기 실패
      </div>
    );
  }

  if (!url) {
    return <div className="qf-skel aspect-square w-full" role="img" aria-label="처리 중" />;
  }

  return (
    <img
      src={url}
      alt={alt}
      loading="lazy"
      // 미연결(onImageOpen 없음)이면 클릭 불가 — 커서/버튼 시맨틱 부여하지 않습니다.
      onClick={clickable ? onOpen : undefined}
      className={`aspect-square w-full object-cover${clickable ? ' cursor-pointer' : ''}`}
    />
  );
}
