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
export type TriggerKind = 'mention' | 'channel' | 'emoji' | 'slash';

/**
 * S78 reviewer FF6 (contract): 트리거 종류 → 한국어 섹션 명사 단일 출처.
 * 종전엔 Autocomplete.tsx(`SECTION_LABEL`)와 composerAnnouncement.ts
 * (`AC_SECTION_NOUN`)에 동일 매핑이 중복돼 있었습니다 — 한쪽만 고치면 SR
 * 공지와 시각 섹션 라벨이 어긋날 위험이 있어 여기로 통합합니다(향후 슬래시/
 * 검색 종류 추가도 한 곳에서). 자동완성 listbox 섹션 헤더와 SR 결과 공지가
 * 이 동일 명사를 공유합니다.
 *
 * S79 (FR-SC-01): 슬래시 커맨드 추가. 공지 문구는 "슬래시 커맨드 N개" 로 읽힙니다.
 */
export const TRIGGER_KIND_LABEL: Record<TriggerKind, string> = {
  // S88a review F7 (a11y/ui): @ 트리거는 멤버뿐 아니라 멘션 가능 역할도 함께
  // 노출하므로 '멤버 및 역할' 로 표기한다. 이 단일 출처가 listbox aria-label·
  // 섹션 헤더·composerAnnouncement SR 공지를 모두 구동해 3건이 동시 정합한다.
  mention: '멤버 및 역할',
  channel: '채널',
  emoji: '이모지',
  slash: '슬래시 커맨드',
};

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
  '/': 'slash',
};

/** 멘션/채널/이모지 query 로 허용되는 문자(공백·개행은 토큰 종료). */
function isQueryChar(ch: string): boolean {
  return /[A-Za-z0-9_.\-+]/.test(ch);
}

/** sigil 앞에 와도 되는 경계 문자(단어 문자가 아니면 OK). */
function isBoundaryBefore(ch: string): boolean {
  return !/[A-Za-z0-9_]/.test(ch);
}

/**
 * S79 (FR-SC-01): 슬래시 sigil 의 경계 검사. 슬래시 커맨드는 **줄 맨앞**(인덱스 0
 * 또는 개행 직후)에서만 트리거한다. 일반 멘션/채널/이모지처럼 "공백 직후"까지 허용하면
 * URL(`https://`)·경로(`/var`)·일반 문장("and /or")이 오작동하므로, 슬래시는 경계를
 * "줄 맨앞" 으로 좁힌다(Discord parity). prevChar 가 없거나(=줄 맨앞) 개행일 때만 true.
 */
function isSlashLineStart(text: string, sigilIndex: number): boolean {
  if (sigilIndex === 0) return true;
  const prev = text[sigilIndex - 1];
  return prev === '\n' || prev === '\r';
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

  // S79 (FR-SC-01): 슬래시는 줄 맨앞 전용 경계를 쓴다(URL/경로/일반 문장 오작동 방지).
  // 그 외(멘션/채널/이모지)는 종전대로 "단어 문자가 아닌 경계" 면 허용한다(이메일 a@b 차단).
  if (kind === 'slash') {
    if (!isSlashLineStart(text, i)) return null;
  } else if (i > 0 && !isBoundaryBefore(text[i - 1])) {
    return null;
  }

  const query = text.slice(i + 1, caret);
  if (kind === 'emoji' && query.length < EMOJI_MIN_QUERY) return null;
  return { kind, query, start: i, end: caret };
}
