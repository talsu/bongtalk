/**
 * S49 (D06 / FR-MN-17): 뮤트 "남은 시간" 표시 포맷터.
 *
 * 뮤트 목록 카드가 표시하는 남은 시간 카피를 순수 함수로 분리해 결정적으로 단위
 * 검증한다(vi.setSystemTime 기준). 정책:
 *
 *   - until == null  → "무기한"(영구 뮤트).
 *   - until <= now    → "곧 해제됨"(만료 직전/경계 — 서버가 만료 행을 거르지만
 *     캐시 갭에서 음수가 나올 수 있어 0 이하는 이 카피로 안전 처리).
 *   - 그 외           → 가장 큰 단위 1개로 "약 N일/시간/분 남음"(분 미만은 "1분 미만 남음").
 *
 * 단위 1개만(일|시간|분) 노출해 카드 한 줄에 맞춘다 — 정밀 만료 시각은 <time> 의
 * dateTime/title 속성이 SR/툴팁으로 제공한다(컴포넌트가 부여).
 */

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;

export function formatMuteRemaining(untilIso: string | null, now: number): string {
  if (untilIso === null) return '무기한';
  const until = new Date(untilIso).getTime();
  const diff = until - now;
  if (Number.isNaN(diff)) return '무기한';
  if (diff <= 0) return '곧 해제됨';
  if (diff >= DAY_MS) {
    const days = Math.floor(diff / DAY_MS);
    return `약 ${days}일 남음`;
  }
  if (diff >= HOUR_MS) {
    const hours = Math.floor(diff / HOUR_MS);
    return `약 ${hours}시간 남음`;
  }
  if (diff >= MIN_MS) {
    const mins = Math.floor(diff / MIN_MS);
    return `약 ${mins}분 남음`;
  }
  return '1분 미만 남음';
}
