/**
 * S31 (FR-S02): 수식어 자동완성 토큰 감지 + 완성.
 *
 * 입력 중 현재(마지막) 토큰이 `from:`/`in:`/`has:` 수식어이고 값 prefix 를
 * 가지면 인라인 자동완성 후보를 띄웁니다. from:→유저, in:→채널, has:→정적
 * 옵션(image/file/link). 순수 함수라 DOM 없이 단위 테스트합니다.
 *
 * before:/after:/during:/is: 는 자동완성 대상이 아니므로(날짜·고정값)
 * 여기서는 from/in/has 만 활성 토큰으로 인정합니다.
 */

/** has: 정적 옵션(FR-S02 — 자동완성 후보가 고정된 수식어). */
export const HAS_STATIC_OPTIONS = ['image', 'file', 'link'] as const;

export type SuggestKind = 'user' | 'channel' | 'has';

export interface ActiveModifierToken {
  /** 수식어 키(from/in/has). */
  key: 'from' | 'in' | 'has';
  /** 자동완성 종류. */
  kind: SuggestKind;
  /** @/# 접두를 제거한 값 prefix(빈 문자열이면 막 입력 시작). */
  prefix: string;
  /** 토큰이 시작하는 입력 문자열 인덱스(완성 시 치환 범위). */
  start: number;
}

const KEY_TO_KIND: Record<string, SuggestKind> = {
  from: 'user',
  in: 'channel',
  has: 'has',
};

/**
 * 입력 문자열의 마지막(활성) 토큰을 보고 자동완성 가능한 수식어인지 판정합니다.
 * 공백으로 끝나면(토큰 확정) null. 마지막 토큰이 from/in/has 수식어가 아니면
 * null. @/# 접두는 prefix 에서 제거합니다.
 *
 * S31 (reviewer MAJOR2): caret(selectionStart)은 보지 않고 항상 *마지막 토큰*
 * 만 본다. 커서가 중간 토큰 안에 있어도 마지막 토큰을 활성으로 본다 — 중간
 * 토큰 편집 자동완성은 carryover.
 */
export function detectActiveModifierToken(input: string): ActiveModifierToken | null {
  // 공백으로 끝나면 활성 토큰 없음(직전 토큰은 확정됨).
  if (input.length === 0 || /\s$/.test(input)) return null;
  const lastSpace = input.lastIndexOf(' ');
  const start = lastSpace + 1;
  const token = input.slice(start);
  const colon = token.indexOf(':');
  if (colon <= 0) return null;
  const key = token.slice(0, colon).toLowerCase();
  const kind = KEY_TO_KIND[key];
  if (!kind) return null;
  let value = token.slice(colon + 1);
  if (value.startsWith('@') || value.startsWith('#')) value = value.slice(1);
  return { key: key as ActiveModifierToken['key'], kind, prefix: value, start };
}

/**
 * 활성 토큰을 선택한 값으로 완성한 새 입력 문자열을 만듭니다. `start` 부터
 * 끝까지를 `key:value ` 로 치환하고 트레일링 공백을 붙여 다음 토큰 입력을
 * 자연스럽게 합니다. value 는 호출측이 @/# 접두를 포함해 넘깁니다(유저=@x,
 * 채널=#x, has=image).
 */
export function completeModifierToken(
  input: string,
  start: number,
  key: string,
  value: string,
): string {
  return `${input.slice(0, start)}${key}:${value} `;
}
