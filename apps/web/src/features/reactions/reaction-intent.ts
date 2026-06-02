/**
 * S39 fix-forward (reviewer MAJOR ★2 — per-viewer `me` sticky-ghost):
 *
 * reaction:updated 브로드캐스트 페이로드는 per-viewer `byMe` 를 담을 수 없어(수신자
 * 마다 다름) 클라가 users[≤5] 에 내 userId 포함 여부로 로컬 계산합니다. 그런데
 * reactor 가 6명 이상인 이모지에서 내가 cap 밖이면 users 에 안 잡혀, 종전 dispatcher
 * 는 `byMe = inUsers || prevByMe` 로 직전 캐시값을 영구 latch 했습니다 — 내가 방금
 * 반응을 *제거*했는데도 byMe 가 true 로 굳는 "유령" 회귀였습니다.
 *
 * 해결: 이 모듈이 (messageId, emoji) 조합별로 **뷰어의 권위적 로컬 의도**(서버 응답
 * 또는 in-flight 토글이 확정한 byMe)를 보관합니다. dispatcher 는 latch 대신 이 의도를
 * 우선 참조해 byMe 를 결정합니다(의도가 있으면 그 값, 없으면 `inUsers`). 이렇게 하면:
 *   - cap 밖이라도 내가 방금 제거하면 의도 byMe=false → dispatcher 가 false 로 정확 수렴.
 *   - 내가 추가한 직후의 깜빡임(낙관 true → users 미포함으로 false 로 잠깐 뒤집힘)을 방지.
 *   - 다른 사람만 반응한 이모지(의도 없음)는 순수 `inUsers` 로 계산 — latch 제거.
 *
 * 의도는 **세션 메모리**의 단순 Map 입니다(persist 불필요 — WS 가 진실값이고, 의도는
 * WS 와 합의에 이르면 만료/덮어쓰기 됩니다). React 트리 밖 모듈 싱글톤이라 훅과
 * dispatcher 가 동일 인스턴스를 공유합니다(테스트는 `__resetReactionIntents` 로 격리).
 */

type Combo = string; // `${messageId}::${emoji}`

type IntentEntry = {
  /** 뷰어가 의도(또는 서버가 확정)한 최종 byMe 상태. */
  byMe: boolean;
  /** 이 의도를 기록한 시각(epoch ms). 만료 판단에 사용. */
  recordedAt: number;
};

const intents = new Map<Combo, IntentEntry>();

/**
 * 의도 만료 윈도우(ms). 의도를 무한정 유지하면, 다른 기기에서 내가 반응을 바꾼 뒤
 * 들어온 reaction:updated 를 stale 한 로컬 의도가 덮어써 버립니다. 토글 왕복(낙관 →
 * POST → WS 수렴)이 끝날 만큼은 넉넉히, 그러나 멀티세션 동기화를 막지는 않을 만큼
 * 짧게 둡니다. dispatcher 가 의도를 소비할 때 이 윈도우를 넘긴 항목은 무시·삭제합니다.
 */
export const REACTION_INTENT_TTL_MS = 10_000;

function comboKey(messageId: string, emoji: string): Combo {
  return `${messageId}::${emoji}`;
}

/**
 * (messageId, emoji) 조합에 뷰어의 권위적 의도를 기록합니다. useReactions 가
 *   - 낙관적 토글 직후(터미널 의도) 와
 *   - POST 응답 수신 시(서버 권위 byMe)
 * 호출합니다. 같은 조합의 이전 의도를 덮어씁니다.
 */
export function recordReactionIntent(messageId: string, emoji: string, byMe: boolean): void {
  intents.set(comboKey(messageId, emoji), { byMe, recordedAt: Date.now() });
}

/**
 * dispatcher 가 reaction:updated 의 byMe 를 계산할 때 참조합니다. 살아있는(미만료)
 * 의도가 있으면 그 byMe 를, 없으면 null 을 돌려줍니다(null 이면 호출자는 users
 * 포함 여부로 계산). 만료된 항목은 조회 시 청소합니다(WS 가 진실값으로 수렴 완료).
 */
export function peekReactionIntent(messageId: string, emoji: string): boolean | null {
  const key = comboKey(messageId, emoji);
  const entry = intents.get(key);
  if (!entry) return null;
  if (Date.now() - entry.recordedAt > REACTION_INTENT_TTL_MS) {
    intents.delete(key);
    return null;
  }
  return entry.byMe;
}

/**
 * 특정 조합의 의도를 즉시 제거합니다. POST 실패로 롤백한 뒤, 이미 합의에 이른
 * 직후 등 의도를 더 붙들 이유가 없을 때 호출합니다(없으면 no-op).
 */
export function clearReactionIntent(messageId: string, emoji: string): void {
  intents.delete(comboKey(messageId, emoji));
}

/** 테스트 격리용 — 모든 의도를 비웁니다. 프로덕션 코드에서는 호출하지 않습니다. */
export function __resetReactionIntents(): void {
  intents.clear();
}
