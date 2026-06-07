/**
 * S04 (FR-MSG-13 / FR-RC22) — 멘션 정규화: `@username` → `@{cuid2}`.
 *
 * 클라이언트는 컴포저에서 `@username` 자동완성으로 멘션을 삽입하고, 서버는
 * 저장 시 채널 멤버를 resolve 해 핸들을 `@{cuid2}` 토큰으로 치환합니다. 이로써
 * mrkdwn 파서(`@qufox/shared-types`)의 `mention_user` AST 노드가 활성화되어
 * (S02 carryover MED-3) 렌더러가 violet pill 로 표시할 수 있게 됩니다.
 *
 * 안정성:
 *   - 코드펜스(```...```)와 인라인 코드(`...`) 안의 `@username` 은 literal 로
 *     보존합니다(파서가 코드블록 내부를 파싱하지 않는 것과 정합). 정규식
 *     백트래킹 없이 단일 패스 스캐너로 코드 영역을 건너뜁니다.
 *   - `@everyone` / `@here` / `@channel` 특수 멘션은 치환하지 않습니다
 *     (extractMentions 가 별도로 처리).
 *   - 이미 `@{cuid2}` 인 토큰은 다시 건드리지 않습니다(멱등성).
 */

/**
 * `@username` 토큰. 핸들 문법은 SignupRequestSchema 와 동일(2-32, alnum/._-).
 * `@` 앞에 단어 문자가 없을 때만 매칭(이메일 local part 오탐 방지). `@` 뒤에
 * `{` 가 오는 `@{cuid2}` 토큰은 username 문자클래스에 `{` 가 없어 매칭되지
 * 않습니다. 앵커드 단일 문자클래스 + 단순 수량자라 ReDoS 안전합니다.
 */
export const USERNAME_MENTION_RE = /(?<![A-Za-z0-9_])@([A-Za-z0-9_.-]{2,32})/g;

const SPECIAL_MENTIONS = new Set(['everyone', 'here', 'channel']);

/**
 * 핸들 → userId(cuid2) 또는 null(미해결). null 이면 해당 토큰을 literal 로
 * 둡니다. 대소문자 정책은 resolver 가 결정합니다(핸들은 보통 case-insensitive).
 */
export type MentionResolver = (handle: string) => string | null;

/**
 * S88a (FR-MN-03): 알려진 역할 1건 — `@<RoleName>` 토큰을 `<@&roleId>` 로 치환하기
 * 위한 (정확한 역할명, roleId) 쌍. 게이트를 통과한 역할만 넘긴다.
 */
export type RoleNameToken = { name: string; roleId: string };

/** 정규식 메타문자 이스케이프 — 알려진 역할명을 anchored 정규식에 안전하게 박는다. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * contentRaw 의 멘션을 안정 토큰으로 정규화합니다. 코드 영역은 그대로 보존합니다.
 *
 * S88a (FR-MN-03): **역할 패스를 user 패스보다 먼저** 수행합니다 — 게이트를 통과한
 * 알려진 역할명 `@<RoleName>` 을 `<@&roleId>` 로 치환한 뒤, 그 다음 기존 user 패스가
 * `@username` 을 `@{userId}` 로 치환합니다. 다단어 역할명("Project Managers")을 user
 * 패스가 첫 단어만 부분 매칭해 갉아먹지 않도록 순서를 보장합니다. 코드 영역과
 * 특수멘션(@everyone/@here/@channel), 미해결 핸들은 원문 그대로 둡니다.
 *
 * roleTokens 미지정/빈 배열이면 역할 패스를 건너뜁니다(기존 호출부 호환).
 */
export function normalizeMentions(
  raw: string,
  resolve: MentionResolver,
  roleTokens: RoleNameToken[] = [],
): string {
  // 1) 역할 패스 — 게이트 통과 역할명 @<RoleName> → <@&roleId>. 긴 이름 우선으로
  //    치환해 "PM Leads" 가 "PM" 보다 먼저 매칭되게 한다(부분 매칭 방지).
  const withRoles = roleTokens.length === 0 ? raw : replaceRoleTokens(raw, roleTokens);

  // 2) user 패스 — @username → @{userId}. 역할 토큰 치환 후의 본문을 받는다.
  const codeSpans = collectCodeSpans(withRoles);
  const inCode = (idx: number): boolean => codeSpans.some((s) => idx >= s.start && idx < s.end);

  USERNAME_MENTION_RE.lastIndex = 0;
  let out = '';
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = USERNAME_MENTION_RE.exec(withRoles)) !== null) {
    const handle = m[1];
    const start = m.index;
    // 특수 멘션·코드 영역 토큰은 원문 유지.
    if (SPECIAL_MENTIONS.has(handle.toLowerCase()) || inCode(start)) {
      continue;
    }
    const userId = resolve(handle);
    if (!userId) continue; // 미해결 핸들 → literal
    out += withRoles.slice(cursor, start);
    out += `@{${userId}}`;
    cursor = start + m[0].length;
  }
  out += withRoles.slice(cursor);
  return out;
}

/**
 * S88a (FR-MN-03): 알려진 역할명 `@<RoleName>` 을 `<@&roleId>` 로 치환한다. 코드
 * 영역은 보존하고, 긴 이름 우선으로 순차 치환해 다단어 역할명이 부분 매칭으로
 * 깨지지 않게 한다. 정규식은 알려진 이름만 이스케이프 후 경계 anchored ·
 * case-insensitive(ReDoS 안전 — bounded known set).
 */
function replaceRoleTokens(raw: string, roleTokens: RoleNameToken[]): string {
  // 코드 영역을 매 치환마다 재계산하면 인덱스가 어긋나므로, 치환 시 캡처 그룹으로
  // 멘션의 선행/후행 경계를 보존하며 한 토큰씩 전역 치환한다. 코드 영역 보호는
  // anchored boundary(앞 비단어 · 뒤 비단어)로 충분하지 않으므로, 단일 패스 스캐너
  // 대신 토큰별로 코드 영역 밖에서만 치환한다.
  const sorted = [...roleTokens].sort((a, b) => b.name.length - a.name.length);
  let text = raw;
  for (const { name, roleId } of sorted) {
    const trimmed = name.trim();
    if (trimmed.length === 0) continue;
    const re = new RegExp(`(?<![A-Za-z0-9_])@${escapeRegExp(trimmed)}(?![A-Za-z0-9_])`, 'gi');
    // 코드 영역은 매 토큰 치환 직전에 재수집한다(앞선 치환으로 길이가 바뀌므로).
    const codeSpans = collectCodeSpans(text);
    const inCode = (idx: number): boolean => codeSpans.some((s) => idx >= s.start && idx < s.end);
    let out = '';
    let cursor = 0;
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      if (inCode(start)) continue; // 코드 영역 내부 토큰은 보존.
      out += text.slice(cursor, start);
      out += `<@&${roleId}>`;
      cursor = start + m[0].length;
    }
    out += text.slice(cursor);
    text = out;
  }
  return text;
}

interface CodeSpan {
  start: number;
  end: number;
}

/**
 * fenced code block(```...```)과 inline code(`...`) 영역의 [start, end) 범위를
 * 수집합니다. 라인 기반 펜스 감지 + 문자 기반 백틱 매칭. 닫히지 않은 펜스/
 * 백틱은 문서 끝까지 코드로 간주합니다(파서 동작과 정합 — 보수적).
 */
function collectCodeSpans(raw: string): CodeSpan[] {
  const spans: CodeSpan[] = [];
  let i = 0;
  const n = raw.length;
  while (i < n) {
    // fenced code block — 라인 시작의 ``` (앞에 공백 허용 안 함, 파서와 동일)
    if (isFenceAt(raw, i)) {
      const fenceStart = i;
      // 여는 펜스 라인 끝까지 전진
      let j = lineEnd(raw, i);
      // 닫는 펜스 탐색
      while (j < n) {
        const ls = j; // line start
        if (isFenceAt(raw, ls)) {
          j = lineEnd(raw, ls);
          break;
        }
        j = lineEnd(raw, ls);
      }
      spans.push({ start: fenceStart, end: j });
      i = j;
      continue;
    }
    // inline code — 단일 백틱 쌍(줄바꿈 넘지 않음, 파서와 동일)
    if (raw[i] === '`') {
      const codeStart = i;
      let k = i + 1;
      while (k < n && raw[k] !== '`' && raw[k] !== '\n') k += 1;
      if (k < n && raw[k] === '`') {
        spans.push({ start: codeStart, end: k + 1 });
        i = k + 1;
        continue;
      }
      // 닫히지 않은 백틱 → literal, 한 칸 전진
      i += 1;
      continue;
    }
    i += 1;
  }
  return spans;
}

/** 위치 `i` 가 라인 시작이고 그 라인이 ``` 로 시작하는지. */
function isFenceAt(raw: string, i: number): boolean {
  const atLineStart = i === 0 || raw[i - 1] === '\n';
  return atLineStart && raw.startsWith('```', i);
}

/** `i` 가 속한 라인의 다음 라인 시작 인덱스(또는 문서 끝). */
function lineEnd(raw: string, i: number): number {
  const nl = raw.indexOf('\n', i);
  return nl === -1 ? raw.length : nl + 1;
}
