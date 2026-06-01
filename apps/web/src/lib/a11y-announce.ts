/**
 * S23 (FR-RS-11): 전역 a11y 라이브 영역 공지 헬퍼.
 *
 * 단축키처럼 컴포넌트 밖(이벤트 핸들러)에서 스크린리더 공지를 보내야 할 때 쓴다.
 * `aria-live="polite"` 시각 숨김 영역을 lazily 만들어(싱글턴) 텍스트를 갱신한다.
 * 메시지가 같아도 매번 읽히도록 빈 문자열로 리셋 후 다음 tick 에 채운다.
 *
 * SSR/노드 테스트(document 부재)에서는 안전하게 no-op 한다.
 */
let region: HTMLElement | null = null;

function ensureRegion(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  if (region && document.body.contains(region)) return region;
  const el = document.createElement('div');
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  // S23 cheap fix (#9): aria-atomic 명시 — 라이브 영역 전체를 한 단위로 다시
  // 읽게 해, 부분 갱신으로 SR 이 일부만 읽는 일을 막는다.
  el.setAttribute('aria-atomic', 'true');
  el.setAttribute('data-testid', 'a11y-live-region');
  // 시각적으로 숨기되 SR 에는 노출(표준 visually-hidden 패턴, raw px 아님 —
  // 1px 클립 박스는 a11y 관용 상수라 토큰화 대상 아님).
  el.style.position = 'absolute';
  el.style.width = '1px';
  el.style.height = '1px';
  el.style.overflow = 'hidden';
  el.style.clip = 'rect(0 0 0 0)';
  el.style.clipPath = 'inset(50%)';
  el.style.whiteSpace = 'nowrap';
  document.body.appendChild(el);
  region = el;
  return el;
}

export function announce(message: string): void {
  const el = ensureRegion();
  if (!el) return;
  el.textContent = '';
  // S23 cheap fix (#9): 50ms → 100ms. 일부 스크린리더는 reset 후 50ms 안의
  // 텍스트 갱신을 같은 mutation 으로 합쳐 재공지를 놓친다. 100ms 로 늘려
  // 동일 문자열도 안정적으로 재공지되게 한다.
  window.setTimeout(() => {
    el.textContent = message;
  }, 100);
}
