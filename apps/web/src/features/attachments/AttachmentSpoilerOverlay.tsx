import { useRef, useState } from 'react';

/**
 * S56 (D11 / FR-AM-22) — 스포일러 첨부 래퍼. revealed 전까지 자식(이미지 등)을
 * 블러 처리하고 위에 "SPOILER" 배지를 띄웁니다. 클릭/Enter/Space 로 공개합니다.
 *
 * S59 (D11 / FR-AM-19): 스포일러를 **toggle** 로 바꿉니다 — 공개 후 다시 클릭하면
 * 다시 가립니다(D01 본문 스포일러와 동일 동작). S56 의 단방향(reveal 전용) 결정
 * (a11y B-05 주석)을 FR-AM-19 정본(toggle 요구)에 맞춰 수정했습니다.
 *
 * a11y:
 *   - reveal 버튼은 항상 존재하지만 revealed 면 콘텐츠 위가 아니라 좌상단 작은
 *     토글 버튼(eye/eye-off)으로 바뀝니다. 토글 의미라 aria-pressed 로 공개 상태를
 *     보조기술에 통지합니다(revealed=true → aria-pressed="true").
 *   - 미공개 시 자식 래퍼는 aria-hidden 으로 공개 전 alt 노출을 차단합니다(N-02).
 *   - 공개 직후 콘텐츠 래퍼(tabIndex=-1)로 포커스를 옮겨 가림 버튼이 위치를 바꿔도
 *     포커스가 소실되지 않게 합니다.
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

  const toggle = (): void => {
    setRevealed((prev) => {
      const next = !prev;
      if (next) {
        // 공개 시: 가림 버튼이 작은 토글로 바뀌므로 콘텐츠로 포커스를 옮겨 소실 방지.
        queueMicrotask(() => contentRef.current?.focus());
      }
      return next;
    });
  };

  return (
    <div className="relative inline-block overflow-hidden rounded-[var(--r-md)]">
      <div
        ref={contentRef}
        tabIndex={-1}
        // N-02: 공개 전에는 자식(이미지 alt 포함)을 접근성 트리에서 숨깁니다.
        aria-hidden={!revealed}
        className={cnBlur(revealed)}
      >
        {children}
      </div>
      {!revealed ? (
        // 미공개: 콘텐츠 전체를 덮는 reveal 버튼(클릭 공개).
        <button
          type="button"
          data-testid="spoiler-reveal"
          // FR-AM-19: toggle 의미 — aria-pressed 로 공개/숨김 상태를 통지(현재 false).
          aria-pressed={false}
          aria-label={label ? `스포일러 공개: ${label}` : '스포일러 공개'}
          onClick={toggle}
          className="absolute inset-0 flex items-center justify-center bg-[color:var(--scrim)]"
        >
          <span className="qf-badge qf-badge--accent">SPOILER</span>
        </button>
      ) : (
        // 공개됨: 좌상단의 작은 "다시 가리기" 토글(재클릭 시 다시 가림 — FR-AM-19).
        <button
          type="button"
          data-testid="spoiler-hide"
          aria-pressed
          aria-label={label ? `스포일러 다시 가리기: ${label}` : '스포일러 다시 가리기'}
          onClick={toggle}
          className="absolute left-[var(--s-1)] top-[var(--s-1)] qf-badge qf-badge--accent"
        >
          SPOILER
        </button>
      )}
    </div>
  );
}

function cnBlur(revealed: boolean): string | undefined {
  return revealed ? undefined : 'blur-lg';
}
