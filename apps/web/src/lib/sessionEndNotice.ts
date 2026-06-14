/**
 * 072 백로그 S-H (N6-3 / FR-AUTH-55): 비자발적 세션 종료 통지.
 *
 * 강제 로그아웃(리프레시 실패=만료 / 서버 session:revoked=다른 기기·관리자·계정 비활성화)
 * 직전에 사유를 sessionStorage 에 적어두고, /login 으로 리다이렉트된 LoginPage 가 1회 읽어
 * 배너로 안내한 뒤 지운다(조용한 로그아웃 → "왜 로그아웃됐는지" 안내). 사용자가 능동적으로
 * 누른 로그아웃에는 사용하지 않는다(forceLogout/401 경로 전용).
 *
 * sessionStorage 를 쓰는 이유: 새로고침/하드 네비게이션을 넘겨 1회 통지하되 탭 종료 시 사라지게
 * 한다(localStorage 의 영구성·다중탭 누출 회피). 클라 전용 — 서버 신규 이벤트 불요.
 */
export type SessionEndReason = 'expired' | 'revoked';

const KEY = 'qufox:sessionEnded';

// 072 S-H 리뷰(LOW): React.StrictMode(dev)는 컴포넌트를 이중 마운트해 consume 를 두 번
// 호출한다. storage 만 쓰면 1번째가 비워 2번째가 null → 배너가 dev 에서 사라진다. 같은
// 페이지-로드 내 반복 consume 가 동일 값을 반환하도록 모듈 캐시로 1-shot 을 보장한다.
// 새 markSessionEnded(다음 강제 로그아웃) 시 캐시를 리셋해 새 사유가 정상 표시되게 한다.
let cachedConsumed: SessionEndReason | null = null;
let didConsume = false;

export function markSessionEnded(reason: SessionEndReason): void {
  try {
    window.sessionStorage.setItem(KEY, reason);
  } catch {
    /* SSR / quota — 무시(통지 실패는 로그아웃 자체를 막지 않는다) */
  }
  // 새 사유가 들어왔으니 consume 캐시를 리셋(다음 LoginPage 마운트가 새로 읽게).
  didConsume = false;
  cachedConsumed = null;
}

/** 1회 소비(읽고 제거). StrictMode 이중 호출은 같은 값을 반환. 유효 사유 아니면 null. */
export function consumeSessionEndedReason(): SessionEndReason | null {
  if (didConsume) return cachedConsumed;
  didConsume = true;
  try {
    const v = window.sessionStorage.getItem(KEY);
    window.sessionStorage.removeItem(KEY);
    cachedConsumed = v === 'expired' || v === 'revoked' ? v : null;
  } catch {
    cachedConsumed = null;
  }
  return cachedConsumed;
}

/**
 * 072 S-H 리뷰(MEDIUM): 자발적 계정 비활성화는 서버 session:revoked 가 먼저 도착해
 * markSessionEnded('revoked')를 적어, 본인이 한 액션인데 "다른 기기/관리자" 배너가 뜬다.
 * 능동 비활성화 경로가 navigate 전에 이걸 호출해 잘못된 통지를 억제한다.
 */
export function clearSessionEndedReason(): void {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    /* SSR / quota — 무시 */
  }
  didConsume = false;
  cachedConsumed = null;
}
