/**
 * Pure label formatter for the typing indicator. Extracted from the
 * component so the logic can be unit-tested without SSR / zustand
 * gymnastics. The formatter always excludes the viewer.
 *
 *   []                → null (no indicator rendered)
 *   [a]               → "a 입력 중…"
 *   [a, b]            → "a, b 입력 중…"
 *   [a, b, c]         → "a, b 외 1명 입력 중…"
 *   [a, b, c, d]      → "a, b 외 2명 입력 중…"
 */
export function formatTypingLabel(
  userIds: string[],
  viewerId: string | null,
  nameByUserId: Map<string, string>,
): string | null {
  const others = userIds.filter((id) => id !== viewerId);
  if (others.length === 0) return null;
  const names = others.map((id) => nameByUserId.get(id) ?? '익명');
  if (names.length === 1) return `${names[0]} 입력 중…`;
  if (names.length === 2) return `${names[0]}, ${names[1]} 입력 중…`;
  return `${names[0]}, ${names[1]} 외 ${names.length - 2}명 입력 중…`;
}
