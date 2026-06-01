/**
 * S29 (FR-S05): 검색 수식어 파서.
 *
 * Discord-parity 검색 문법을 토큰 단위로 분해합니다. 입력 쿼리에서
 * `from:@user` / `in:#channel` / `has:link|image|file` / `before:`
 * `after:` / `during:` / `is:pinned` 토큰을 추출하고, 남은 자유 텍스트는
 * tsquery 로 넘길 `text` 로 반환합니다. 복합 AND 의미입니다 — 추출된
 * 모든 modifier 는 SQL WHERE 에서 AND 로 결합됩니다(service 레이어).
 *
 * 설계 원칙:
 *  - 순수 함수(부수효과 없음, 시계 주입). 단위 테스트로 100% cover.
 *  - 핸들/채널명은 *이름 그대로* 반환합니다. userId / channelId 해석은
 *    service 레이어가 가시 집합(visible set) 안에서 수행합니다 — 파서는
 *    DB 를 모릅니다(오라클 방지의 1차 경계는 service).
 *  - 알 수 없는 modifier(`foo:bar`)는 텍스트로 취급해 tsquery 로 흘립니다
 *    (조용한 degrade — 400 던지지 않음).
 *  - `during:` 은 상대 기간(today/yesterday/week/month) 또는 `YYYY-MM`
 *    월 범위를 [start, endExclusive) 로 변환합니다. before/after 는
 *    `YYYY-MM-DD` 일 경계를 사용합니다.
 */

export type HasType = 'link' | 'image' | 'file';

export interface ParsedSearchQuery {
  /** tsquery 로 넘길 잔여 자유 텍스트(modifier 제거 후, trim). */
  text: string;
  /** from:@user — 핸들(앞의 @ 제거). 마지막 지정값이 우선. */
  fromHandle?: string;
  /** in:#channel — 채널명(앞의 # 제거). 마지막 지정값이 우선. */
  inChannel?: string;
  /** has:link|image|file — 복수 지정 시 AND(모두 충족). */
  has: HasType[];
  /** is:pinned 지정 여부. */
  isPinned: boolean;
  /** before: / after: / during: 에서 유도한 inclusive 하한(>=). */
  since?: Date;
  /** before: / after: / during: 에서 유도한 exclusive 상한(<). */
  until?: Date;
}

const HAS_VALUES: ReadonlySet<string> = new Set(['link', 'image', 'file']);

// S29 (security LOW/방어): from:@handle / in:#channel modifier 값 길이 상한.
// username(32) / 채널명 길이를 넉넉히 덮는 64자. 초과분은 modifier 로 인정하지
// 않고 자유 텍스트로 흘려(degrade) 거대 ILIKE/insensitive 매칭 인자를 막는다.
const MODIFIER_VALUE_MAX = 64;

/** `YYYY-MM-DD` → 그 날 00:00:00Z (UTC). 형식 불일치면 null. */
function parseDateOnly(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  // 유효성: 정규화 후 입력과 일치해야 함(2025-02-31 류 거부).
  if (
    date.getUTCFullYear() !== Number(y) ||
    date.getUTCMonth() !== Number(mo) - 1 ||
    date.getUTCDate() !== Number(d)
  ) {
    return null;
  }
  return date;
}

/** UTC 자정으로 절삭. */
function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * `during:` 토큰 → [since, until) 범위. 상대 키워드는 `now` 기준입니다
 * (시계 주입 — 테스트 결정성). 알 수 없는 값이면 null(무시).
 */
function parseDuring(value: string, now: Date): { since: Date; until: Date } | null {
  const today = startOfUtcDay(now);
  const oneDay = 24 * 60 * 60 * 1000;
  switch (value) {
    case 'today':
      return { since: today, until: new Date(today.getTime() + oneDay) };
    case 'yesterday': {
      const y = new Date(today.getTime() - oneDay);
      return { since: y, until: today };
    }
    case 'week':
      // 최근 7일(오늘 포함) — [today-6d, today+1d).
      return {
        since: new Date(today.getTime() - 6 * oneDay),
        until: new Date(today.getTime() + oneDay),
      };
    case 'month':
      // 최근 30일(오늘 포함).
      return {
        since: new Date(today.getTime() - 29 * oneDay),
        until: new Date(today.getTime() + oneDay),
      };
    default: {
      // `YYYY-MM` 월 전체 범위.
      const m = /^(\d{4})-(\d{2})$/.exec(value);
      if (!m) return null;
      const [, y, mo] = m;
      const month = Number(mo);
      if (month < 1 || month > 12) return null;
      const since = new Date(Date.UTC(Number(y), month - 1, 1));
      const until = new Date(Date.UTC(Number(y), month, 1));
      return { since, until };
    }
  }
}

/**
 * 쿼리 문자열을 modifier + 잔여 텍스트로 분해합니다.
 *
 * @param raw  사용자 입력 쿼리.
 * @param now  `during:` 상대 기간 기준 시각(테스트 주입). 기본 `new Date()`.
 */
export function parseSearchQuery(raw: string, now: Date = new Date()): ParsedSearchQuery {
  const result: ParsedSearchQuery = { text: '', has: [], isPinned: false };
  const textTokens: string[] = [];
  // 공백으로 토큰 분리. 따옴표 구문 지원은 DEFER(선제존재).
  const tokens = raw
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);

  for (const token of tokens) {
    const colon = token.indexOf(':');
    if (colon <= 0) {
      // modifier 가 아님 — 자유 텍스트.
      textTokens.push(token);
      continue;
    }
    const key = token.slice(0, colon).toLowerCase();
    const value = token.slice(colon + 1);
    if (value.length === 0) {
      // `from:` 처럼 값이 비면 텍스트로 취급(degrade).
      textTokens.push(token);
      continue;
    }
    switch (key) {
      case 'from': {
        const handle = value.startsWith('@') ? value.slice(1) : value;
        if (handle.length === 0 || handle.length > MODIFIER_VALUE_MAX) {
          textTokens.push(token); // 비정상 길이 → 자유 텍스트로 degrade
        } else {
          result.fromHandle = handle;
        }
        break;
      }
      case 'in': {
        const channelName = value.startsWith('#') ? value.slice(1) : value;
        if (channelName.length === 0 || channelName.length > MODIFIER_VALUE_MAX) {
          textTokens.push(token); // 비정상 길이 → 자유 텍스트로 degrade
        } else {
          result.inChannel = channelName;
        }
        break;
      }
      case 'has': {
        const v = value.toLowerCase();
        if (HAS_VALUES.has(v) && !result.has.includes(v as HasType)) {
          result.has.push(v as HasType);
        } else if (!HAS_VALUES.has(v)) {
          // 알 수 없는 has 타입(예: has:video DEFER) → 텍스트로 흘림.
          textTokens.push(token);
        }
        break;
      }
      case 'is': {
        if (value.toLowerCase() === 'pinned') {
          result.isPinned = true;
        } else {
          textTokens.push(token);
        }
        break;
      }
      case 'before': {
        const d = parseDateOnly(value);
        if (d) {
          // before:D → < D 자정(그 날 미포함).
          result.until = result.until ? new Date(Math.min(result.until.getTime(), d.getTime())) : d;
        } else {
          textTokens.push(token);
        }
        break;
      }
      case 'after': {
        const d = parseDateOnly(value);
        if (d) {
          // after:D → >= D+1 자정(그 날 미포함, Discord 의미).
          const next = new Date(d.getTime() + 24 * 60 * 60 * 1000);
          result.since = result.since
            ? new Date(Math.max(result.since.getTime(), next.getTime()))
            : next;
        } else {
          textTokens.push(token);
        }
        break;
      }
      case 'during': {
        const range = parseDuring(value, now);
        if (range) {
          result.since = result.since
            ? new Date(Math.max(result.since.getTime(), range.since.getTime()))
            : range.since;
          result.until = result.until
            ? new Date(Math.min(result.until.getTime(), range.until.getTime()))
            : range.until;
        } else {
          textTokens.push(token);
        }
        break;
      }
      default:
        // 알 수 없는 modifier → 텍스트(tsquery)로.
        textTokens.push(token);
    }
  }

  result.text = textTokens.join(' ').trim();
  return result;
}
