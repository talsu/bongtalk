/**
 * S30: 검색 결과 패널의 순수 표시 로직(렌더 무관). React 컴포넌트가 이 함수를
 * 호출해 텍스트/플래그를 만들고, 단위 테스트는 DOM 없이 이 함수를 검증합니다.
 */

/**
 * FR-S03 / FR-S14: 0건 빈 상태의 수식어 힌트 텍스트. FR-S14 는 구체 예시 1줄을
 * 포함하도록 요구합니다(`from:@alice in:#general 배포`).
 */
export function emptyStateHint(query: string): string {
  return `'${query}' 결과 없음. from:, in:, has:로 좁혀보세요. 예: from:@alice in:#general 배포`;
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

/**
 * FR-S01: 최근 검색 0건 첫 포커스 시 노출할 수식어 치트시트 카드 항목.
 *   - example: 입력창에 프리필할 수식어 토큰(트레일링 공백 포함).
 *   - keyPart/rest: __chip-key(키) + 나머지 시각 분리용.
 *   - hint: 항목 의미 설명.
 */
export interface CheatSheetItem {
  example: string;
  keyPart: string;
  rest: string;
  hint: string;
}

export const SEARCH_CHEAT_SHEET: readonly CheatSheetItem[] = [
  { example: 'from:@alice ', keyPart: 'from:', rest: '@alice', hint: '특정 사람' },
  { example: 'in:#general ', keyPart: 'in:', rest: '#general', hint: '특정 채널' },
  { example: 'has:image ', keyPart: 'has:', rest: 'image', hint: '이미지 포함' },
] as const;
