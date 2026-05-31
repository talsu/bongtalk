/**
 * S18 (FR-RC03/04/05) — 컴포저 자동완성 트리거 감지 (순수 함수).
 *
 * 캐럿 위치(`caret`)를 기준으로 왼쪽으로 스캔해 가장 가까운 트리거 sigil
 * (`@` 멘션 · `#` 채널 · `:` 이모지)을 찾습니다. sigil 직전 문자가 단어
 * 문자(예: 이메일 `a@b`)이면 트리거가 아닙니다. query 안에 공백/개행이
 * 들어가면(이미 닫힌 토큰) 트리거가 아닙니다.
 *
 * 이모지(`:`)는 FR-RC05 에 따라 query 가 **2자 이상**일 때만 트리거합니다.
 * 멘션/채널은 sigil 직후(빈 query)부터 팝업을 엽니다.
 *
 * 정규식 백트래킹을 쓰지 않고 단일 역방향 패스로만 스캔하며, query 길이는
 * 핸들 최대치(32)로 상한해 runaway 스캔을 차단합니다.
 */
export type TriggerKind = 'mention' | 'channel' | 'emoji';

export type Trigger = {
  kind: TriggerKind;
  /** sigil 뒤부터 캐럿까지의 검색어(소문자 정규화 전 원문). */
  query: string;
  /** sigil 의 인덱스(치환 시작점). */
  start: number;
  /** 캐럿 인덱스(치환 종료점). */
  end: number;
};

const MAX_QUERY_LEN = 32;
const EMOJI_MIN_QUERY = 2;

const SIGIL: Record<string, TriggerKind> = {
  '@': 'mention',
  '#': 'channel',
  ':': 'emoji',
};

/** 멘션/채널/이모지 query 로 허용되는 문자(공백·개행은 토큰 종료). */
function isQueryChar(ch: string): boolean {
  return /[A-Za-z0-9_.\-+]/.test(ch);
}

/** sigil 앞에 와도 되는 경계 문자(단어 문자가 아니면 OK). */
function isBoundaryBefore(ch: string): boolean {
  return !/[A-Za-z0-9_]/.test(ch);
}

export function detectTrigger(text: string, caret: number): Trigger | null {
  if (caret < 0 || caret > text.length) return null;
  // 캐럿 바로 앞에서 왼쪽으로 query 문자만 따라간다.
  let i = caret - 1;
  let scanned = 0;
  while (i >= 0 && isQueryChar(text[i])) {
    i -= 1;
    scanned += 1;
    if (scanned > MAX_QUERY_LEN) return null;
  }
  // 이제 text[i] 는 sigil 후보(또는 -1).
  if (i < 0) return null;
  const kind = SIGIL[text[i]];
  if (!kind) return null;
  // sigil 직전 경계 검사 — 단어 문자에 붙으면 트리거 아님(이메일 등).
  if (i > 0 && !isBoundaryBefore(text[i - 1])) return null;

  const query = text.slice(i + 1, caret);
  if (kind === 'emoji' && query.length < EMOJI_MIN_QUERY) return null;
  return { kind, query, start: i, end: caret };
}
