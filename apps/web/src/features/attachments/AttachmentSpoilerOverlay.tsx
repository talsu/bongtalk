import { useState } from 'react';

/**
 * S56 (D11 / FR-AM-22) — 스포일러 첨부 래퍼. revealed 전까지 자식(이미지 등)을
 * 블러 처리하고 위에 "SPOILER" 배지를 띄웁니다. 클릭/Enter/Space 로 토글합니다.
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
  return (
    <div className="relative inline-block overflow-hidden rounded-[var(--r-md)]">
      <div className={revealed ? undefined : 'blur-lg'}>{children}</div>
      {!revealed ? (
        <button
          type="button"
          data-testid="spoiler-reveal"
          aria-pressed={revealed}
          aria-label={label ? `스포일러 표시: ${label}` : '스포일러 표시'}
          onClick={() => setRevealed(true)}
          className="absolute inset-0 flex items-center justify-center bg-[color:var(--scrim)]"
        >
          <span className="qf-badge qf-badge--accent">SPOILER</span>
        </button>
      ) : null}
    </div>
  );
}
