import { useRef, useState } from 'react';

/**
 * S56 (D11 / FR-AM-22) — 스포일러 첨부 래퍼. revealed 전까지 자식(이미지 등)을
 * 블러 처리하고 위에 "SPOILER" 배지를 띄웁니다. 클릭/Enter/Space 로 공개합니다.
 *
 * S56 fix-forward (a11y B-05): reveal 은 단방향 액션(다시 숨길 수 없음)이라
 * aria-pressed(토글 의미)는 부적합 — 제거하고 `aria-label="스포일러 공개: …"`
 * 만 둡니다. 공개 후 콘텐츠 래퍼(tabIndex=-1)로 포커스를 이동해 reveal 버튼이
 * 사라지며 포커스가 소실되는 것을 막습니다(N-02: 미공개 시 자식 aria-hidden 으로
 * 공개 전 alt 노출을 차단).
 *
 * DS qf-badge--accent 만 사용하고 raw hex/px 는 쓰지 않습니다.
 */
export function AttachmentSpoilerOverlay({
  children,
  label,
}: {
  children: React.ReactNode;
  /** 스크린리더 컨텍스트(파일명 등). */
  label?: string;
}): JSX.Element {
  const [revealed, setRevealed] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const reveal = (): void => {
    setRevealed(true);
    // 버튼이 언마운트되며 포커스가 소실되므로 콘텐츠 래퍼로 이동(B-05).
    queueMicrotask(() => contentRef.current?.focus());
  };
  return (
    <div className="relative inline-block overflow-hidden rounded-[var(--r-md)]">
      <div
        ref={contentRef}
        tabIndex={-1}
        // N-02: 공개 전에는 자식(이미지 alt 포함)을 접근성 트리에서 숨긴다.
        aria-hidden={!revealed}
        className={cnBlur(revealed)}
      >
        {children}
      </div>
      {!revealed ? (
        <button
          type="button"
          data-testid="spoiler-reveal"
          aria-label={label ? `스포일러 공개: ${label}` : '스포일러 공개'}
          onClick={reveal}
          className="absolute inset-0 flex items-center justify-center bg-[color:var(--scrim)]"
        >
          <span className="qf-badge qf-badge--accent">SPOILER</span>
        </button>
      ) : null}
    </div>
  );
}

function cnBlur(revealed: boolean): string | undefined {
  return revealed ? undefined : 'blur-lg';
}
