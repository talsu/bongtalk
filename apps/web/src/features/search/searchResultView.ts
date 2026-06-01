/**
 * S30: 검색 결과 패널의 순수 표시 로직(렌더 무관). React 컴포넌트가 이 함수를
 * 호출해 텍스트/플래그를 만들고, 단위 테스트는 DOM 없이 이 함수를 검증합니다.
 */

/** FR-S03: 0건 빈 상태의 수식어 힌트 텍스트. */
export function emptyStateHint(query: string): string {
  return `'${query}' 결과 없음. from:, in:, has:로 좁혀보세요.`;
}

/** FR-S06: 권한 마스킹된 컨텍스트 본문 placeholder. */
export const MASKED_CONTEXT_PLACEHOLDER = '[접근 불가 메시지]';

/**
 * FR-S06: 컨텍스트 한 줄의 표시 본문을 결정합니다. masked 면 placeholder,
 * 아니면 서버가 내려준 HTML-escaped text(그대로 렌더 — 이중 escape 회피).
 */
export function contextDisplayText(ctx: { masked: boolean; text: string | null }): string {
  if (ctx.masked || ctx.text === null) return MASKED_CONTEXT_PLACEHOLDER;
  return ctx.text;
}

/** FR-S10: 'In Thread' 레이블 텍스트(루트 excerpt 동반). */
export const IN_THREAD_LABEL = 'In Thread';

/** FR-S07: index-update 배너 안내 문구. */
export const INDEX_UPDATE_BANNER_TEXT = '새 결과가 있을 수 있습니다. 재검색';
