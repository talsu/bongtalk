/**
 * S31 (FR-S13): 클라이언트용 경량 검색 쿼리 게이트.
 *
 * PRD FR-S13: 검색어가 공백뿐이거나, 수식어가 없을 때 3자 미만이면 서버 요청을
 * 보내지 않고 클라이언트에서 거부합니다. 순수 길이 체크가 아니라 파서 결과
 * 기반입니다 — `from:alice` 처럼 수식어가 있으면 자유 텍스트가 0자여도 허용하고,
 * 수식어 없이 일반 텍스트만 있으면 그 텍스트가 3자 이상일 때만 허용합니다.
 *
 * 서버 파서(search-query.parser.ts)를 복제하지 않고, 수식어 인식에 필요한
 * *키 목록* 만 공유하는 작은 순수 함수입니다. before:/after: 의 날짜 유효성
 * 같은 세부 의미는 서버에 맡기고, 여기서는 "값이 있는 알려진 수식어 토큰이
 * 하나라도 있는가"만 판정합니다.
 */

/**
 * S31: 서버 파서가 인식하는 수식어 키 목록(search-query.parser.ts 의 switch
 * 케이스와 동일). 복제를 키 목록 한 곳으로 최소화합니다.
 */
export const SEARCH_MODIFIER_KEYS: ReadonlySet<string> = new Set([
  'from',
  'in',
  'has',
  'before',
  'after',
  'during',
  'is',
]);

/** 자유 텍스트 단독 검색의 최소 길이(수식어가 있으면 무관). */
export const MIN_FREE_TEXT_LENGTH = 3;

/**
 * S31 (reviewer MAJOR1): 게이트가 서버 파서와 동일한 *유효성* 기준으로만
 * 수식어를 인정하도록 강화. 키만 일치하고 값이 무효한 토큰(`has:video`,
 * `before:notadate`, `from:@` 등)은 서버에서 free text 로 강등되므로, 게이트도
 * 동일하게 free text 로 취급해야 FR-S13 짧은쿼리 차단이 무력화되지 않는다.
 */

/** has:link|image|file 만 유효(search-query.parser.ts HAS_VALUES 와 동일). */
const HAS_VALID: ReadonlySet<string> = new Set(['link', 'image', 'file']);

/** during: 상대 키워드(search-query.parser.ts parseDuring 와 동일). */
const DURING_KEYWORDS: ReadonlySet<string> = new Set(['today', 'yesterday', 'week', 'month']);

/** from:@x / in:#x 값 길이 상한(search-query.parser.ts MODIFIER_VALUE_MAX). */
const MODIFIER_VALUE_MAX = 64;

/** `YYYY-MM-DD` 형식 + 정규화 일치 검증(2025-02-31 류 거부). 서버 parseDateOnly 대응. */
function isValidDateOnly(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  return (
    date.getUTCFullYear() === Number(y) &&
    date.getUTCMonth() === Number(mo) - 1 &&
    date.getUTCDate() === Number(d)
  );
}

/** during: 값이 유효(상대 키워드 또는 유효 `YYYY-MM`)한지. 서버 parseDuring 대응. */
function isValidDuring(value: string): boolean {
  const v = value.toLowerCase();
  if (DURING_KEYWORDS.has(v)) return true;
  const m = /^(\d{4})-(\d{2})$/.exec(value);
  if (!m) return false;
  const month = Number(m[2]);
  return month >= 1 && month <= 12;
}

/**
 * 키:값 토큰이 서버 파서 기준 *유효한 수식어* 인지 판정. 키가 알려진
 * 수식어이고 값이 서버에서 실제로 인정되는 형식일 때만 true.
 */
function isValidModifier(key: string, value: string): boolean {
  switch (key) {
    case 'from': {
      const handle = value.startsWith('@') ? value.slice(1) : value;
      return handle.length > 0 && handle.length <= MODIFIER_VALUE_MAX;
    }
    case 'in': {
      const channel = value.startsWith('#') ? value.slice(1) : value;
      return channel.length > 0 && channel.length <= MODIFIER_VALUE_MAX;
    }
    case 'has':
      return HAS_VALID.has(value.toLowerCase());
    case 'is':
      return value.toLowerCase() === 'pinned';
    case 'before':
    case 'after':
      return isValidDateOnly(value);
    case 'during':
      return isValidDuring(value);
    default:
      return false;
  }
}

export interface SearchQueryAnalysis {
  /** 서버 파서 기준 유효한 수식어 토큰이 하나라도 있으면 true. */
  hasModifier: boolean;
  /** 수식어 토큰을 제거한 잔여 자유 텍스트(trim). */
  freeText: string;
}

/**
 * 입력을 공백 토큰으로 분해해 수식어 유무와 잔여 자유 텍스트로 나눕니다.
 * 서버 파서(search-query.parser.ts)와 동일하게 `key:value` 형태에서 값이
 * 비거나(예: `from:`) 키/값이 무효하면(예: `has:video`, `before:nope`,
 * `from:@`) 수식어로 인정하지 않고 자유 텍스트로 흘립니다(degrade).
 */
export function analyzeSearchQuery(raw: string): SearchQueryAnalysis {
  const tokens = raw
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);

  let hasModifier = false;
  const freeTokens: string[] = [];

  for (const token of tokens) {
    const colon = token.indexOf(':');
    if (colon <= 0) {
      freeTokens.push(token);
      continue;
    }
    const key = token.slice(0, colon).toLowerCase();
    const value = token.slice(colon + 1);
    if (value.length > 0 && SEARCH_MODIFIER_KEYS.has(key) && isValidModifier(key, value)) {
      hasModifier = true;
    } else {
      // 값이 없거나(`from:`) 알 수 없는 키(`foo:bar`) 또는 무효한 값
      // (`has:video`/`before:nope`/`from:@`) → 자유 텍스트.
      freeTokens.push(token);
    }
  }

  return { hasModifier, freeText: freeTokens.join(' ').trim() };
}

/**
 * 서버 요청을 보낼 자격이 있는 쿼리인지 판정합니다. 수식어가 있으면 항상 허용,
 * 없으면 자유 텍스트가 MIN_FREE_TEXT_LENGTH 이상일 때만 허용합니다.
 */
export function isSearchQueryAllowed(raw: string): boolean {
  const { hasModifier, freeText } = analyzeSearchQuery(raw);
  return hasModifier || freeText.length >= MIN_FREE_TEXT_LENGTH;
}
