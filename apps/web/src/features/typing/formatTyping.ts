/**
 * Pure label formatter for the typing indicator. Extracted from the
 * component so the logic can be unit-tested without SSR / zustand
 * gymnastics. The formatter always excludes the viewer.
 *
 * S32 (FR-RT-09): PRD 정본 문구.
 *   []                → null (no indicator rendered)
 *   [a]               → "a 님이 입력 중…"
 *   [a, b]            → "a, b 님이 입력 중…"
 *   [a, b, c, …]      → "여러 명이 입력 중…" (≥3명, 이름 비노출)
 *
 * 3명 이상은 개별 이름을 노출하지 않고 "여러 명" 으로 고정 축약합니다(PRD
 * 17111 / FR-RT-09: "3명 이상이면 여러 명이 입력 중…"). 서버 측 동시 표시
 * 상한(TYPING_MAX_VISIBLE=3)과 맞물려, 와이어로 3명까지 와도 라벨은 축약됩니다.
 */
export function formatTypingLabel(
  userIds: string[],
  viewerId: string | null,
  nameByUserId: Map<string, string>,
): string | null {
  const others = userIds.filter((id) => id !== viewerId);
  if (others.length === 0) return null;
  if (others.length >= 3) return '여러 명이 입력 중…';
  const names = others.map((id) => nameByUserId.get(id) ?? '익명');
  if (names.length === 1) return `${names[0]} 님이 입력 중…`;
  return `${names[0]}, ${names[1]} 님이 입력 중…`;
}
