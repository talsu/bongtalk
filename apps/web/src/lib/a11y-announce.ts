/**
 * S23 (FR-RS-11) / S78 (FR-A11Y-01): 전역 a11y 라이브 영역 공지 헬퍼.
 *
 * 단축키처럼 컴포넌트 밖(이벤트 핸들러)에서 스크린리더 공지를 보내야 할 때 쓴다.
 * `aria-live="polite"` 시각 숨김 영역을 lazily 만들어(싱글턴) 텍스트를 갱신한다.
 * 메시지가 같아도 매번 읽히도록 빈 문자열로 리셋 후 다음 tick 에 채운다.
 *
 * S78 (FR-A11Y-01): 모든 자동완성 팝업(슬래시 커맨드·@멘션·이모지 피커·검색
 * 제안)이 동일한 라이브 영역(고정 `id="qf-a11y-announcer"`)을 공유해 결과 수
 * 변경을 알린다. 팝업이 닫히면 호출부가 `announce('', { resetDelayMs: 200 })`
 * 으로 200ms 뒤 빈 문자열로 초기화해 이전 공지가 재낭독되지 않게 한다.
 *
 * race-safe: 초기화(reset) 타이머 ref 를 보관하고, 새 공지를 주입하기 직전에
 * clearTimeout 으로 이전 타이머를 취소한다. 연속 팝업 시 "초기화 → 새 텍스트
 * 주입" 순서를 보장해 중복 낭독/뒤늦은 초기화로 인한 clobber 를 막는다.
 *
 * S78 reviewer M2 (의도 명시): 이 영역은 의도적으로 단일 싱글턴이라, 마지막
 * 호출자의 공지가 이전 공지를 덮어쓴다(cross-caller clobber). 동시에 두
 * 자동완성/단축키 공지가 경쟁하는 상황은 UX 상 발생하지 않으며(한 번에 하나의
 * 컨텍스트만 활성), 단일 라이브 영역이 SR 의 큐 폭주를 막는 의도된 설계다.
 *
 * SSR/노드 테스트(document 부재)에서는 안전하게 no-op 한다.
 */
let region: HTMLElement | null = null;

// 진행 중인 타이머 ref. announce 가 다시 불리면 둘 다 취소해 race 를 막는다.
//  - writeTimer: reset 후 실제 텍스트를 주입하는 타이머.
//  - resetTimer: 팝업 닫힘 시 빈 문자열로 되돌리는 지연 타이머.
let writeTimer: ReturnType<typeof setTimeout> | null = null;
let resetTimer: ReturnType<typeof setTimeout> | null = null;

function ensureRegion(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  if (region && document.body.contains(region)) return region;
  const el = document.createElement('div');
  // S78 (FR-A11Y-01): PRD D15 가 지정한 공유 라이브 영역의 고정 id. 모든
  // 자동완성 팝업이 이 단일 영역을 공유한다.
  el.id = 'qf-a11y-announcer';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  // S23 cheap fix (#9): aria-atomic 명시 — 라이브 영역 전체를 한 단위로 다시
  // 읽게 해, 부분 갱신으로 SR 이 일부만 읽는 일을 막는다.
  el.setAttribute('aria-atomic', 'true');
  // S78 reviewer (a11y MINOR): 텍스트 추가/변경만 통지하도록 relevant 를
  // 명시한다(노드 제거는 무시) — reset→write 순서에서 빈 제거가 잡음으로
  // 읽히는 것을 막는다.
  el.setAttribute('aria-relevant', 'additions text');
  // 기존 testid 유지(테스트 영향 최소·싱글턴 식별).
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

export interface AnnounceOptions {
  /**
   * 빈 문자열 초기화를 이 ms 만큼 지연한다(팝업 닫힘 시). 지정하면 즉시
   * 비우지 않고 타이머로 미뤄, 닫히는 순간의 공지가 잘리지 않게 한다.
   * 기본은 지연 없음(reset 텍스트 주입 경로 그대로).
   */
  resetDelayMs?: number;
}

export function announce(message: string, opts?: AnnounceOptions): void {
  const el = ensureRegion();
  if (!el) return;

  // race-safe: 이전에 예약된 쓰기/초기화 타이머를 모두 취소한다. 이래야 연속
  // 호출에서 뒤늦은 타이머가 최신 공지를 덮어쓰지 않는다.
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  if (resetTimer) {
    clearTimeout(resetTimer);
    resetTimer = null;
  }

  // 빈 문자열 + 지연 옵션이면(팝업 닫힘) 현재 텍스트를 잠시 유지한 뒤 비운다.
  if (message === '' && opts?.resetDelayMs && opts.resetDelayMs > 0) {
    resetTimer = setTimeout(() => {
      el.textContent = '';
      resetTimer = null;
    }, opts.resetDelayMs);
    return;
  }

  el.textContent = '';
  // S23 cheap fix (#9): 50ms → 100ms. 일부 스크린리더는 reset 후 50ms 안의
  // 텍스트 갱신을 같은 mutation 으로 합쳐 재공지를 놓친다. 100ms 로 늘려
  // 동일 문자열도 안정적으로 재공지되게 한다.
  writeTimer = setTimeout(() => {
    el.textContent = message;
    writeTimer = null;
  }, 100);
}
