/**
 * S88a review F3 (data integrity) — 역할 멘션 단일 패스 longest-match 스캐너.
 *
 * `@<RoleName>` 멘션은 역할명이 공백을 포함할 수 있어("Project Managers")
 * 자유 정규식으로 추출할 수 없고, **알려진 워크스페이스 역할명** 집합을 본문에
 * 대조해야 한다. 종전 구현(extractRoleMentions / replaceRoleTokens)은 정렬된
 * 역할명을 각각 원본 text 에 독립 `.test()` / 전역 치환하여, `@PM Leads` 입력에서
 * "PM Leads" 와 "PM" 이 **둘 다** 매칭되는 버그가 있었다. 그 결과:
 *   - 잘못된(짧은 prefix) 역할의 멤버에게도 fanout + rate-limit 소모,
 *   - 저장 토큰(<@&longId>)과 mentions.roles 가 불일치.
 *
 * 본 모듈은 **소비(consumption) 기반 단일 패스 스캐너**로 이를 바로잡는다.
 * 좌→우로 한 번 훑으며 각 위치에서 가장 긴 역할명을 매칭하고, 매칭한 [start,end)
 * 구간을 소비해 커서를 그 끝으로 전진시킨다 — 더 짧은 prefix 가 같은 구간을 다시
 * 매칭할 수 없다. 코드 영역(코드펜스/인라인 코드)은 건너뛴다. extractRoleMentions
 * (추출)과 replaceRoleTokens(정규화)가 **이 동일 스캐너를 공유**하므로, 저장
 * 토큰 ↔ mentions.roles 가 항상 정합한다(동일 매칭 집합 보장).
 *
 * ReDoS 안전: 정규식을 쓰지 않고 각 `@` 위치에서 후보 역할명을 직접 문자열
 * 비교(slice + toLowerCase)로만 매칭하며, 매칭마다 커서를 전진시켜 입력 길이에
 * 선형이다(백트래킹 자체가 없음 · bounded known set). 경계 판정만 1문자 정규식.
 */

/** 스캐너에 넣을 역할 1건 — 정확한(trim 된) 역할명과 그에 결부할 값(roleId 등). */
export interface RoleMentionCandidate<T> {
  /** 정확한 역할명(원본 표기). 빈 문자열/예약어 필터는 호출자가 수행한다. */
  name: string;
  /** 매칭 시 결과 span 에 실어 반환할 값(roleId 또는 토큰). */
  value: T;
}

/** 스캐너가 반환하는 매칭 1건. [start, end) 는 원본 text 기준 소비 구간. */
export interface RoleMentionMatch<T> {
  start: number;
  end: number;
  value: T;
}

interface CodeSpan {
  start: number;
  end: number;
}

/**
 * `@<RoleName>` 토큰을 단일 패스 longest-match 로 스캔한다. 매칭은 소비되어
 * 더 짧은 prefix 가 같은 구간을 재매칭하지 않는다. 코드 영역은 건너뛴다.
 *
 * - 후보는 이름 길이 내림차순으로 정렬해 같은 시작 위치에서 가장 긴 이름이 우선한다.
 * - 매칭 경계: `@` 앞이 비단어(`[A-Za-z0-9_]` 아님), 역할명 뒤가 비단어.
 * - 대소문자 무시(case-insensitive).
 * - 동일 roleId(value) 중복 매칭은 호출자가 dedup 한다(여기서는 모든 매칭 반환).
 */
export function scanRoleMentions<T>(
  text: string,
  candidates: RoleMentionCandidate<T>[],
): RoleMentionMatch<T>[] {
  if (candidates.length === 0) return [];

  // 긴 이름 우선 — 같은 시작점에서 "PM Leads" 가 "PM" 보다 먼저 시도된다.
  const sorted = [...candidates]
    .map((c) => ({ ...c, trimmed: c.name.trim() }))
    .filter((c) => c.trimmed.length > 0)
    .sort((a, b) => b.trimmed.length - a.trimmed.length);
  if (sorted.length === 0) return [];

  const codeSpans = collectCodeSpans(text);
  const inCode = (idx: number): boolean => codeSpans.some((s) => idx >= s.start && idx < s.end);

  const matches: RoleMentionMatch<T>[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    // `@` 위치이고 코드 영역 밖일 때만 매칭 시도.
    if (text[i] !== '@' || inCode(i)) {
      i += 1;
      continue;
    }
    // `@` 앞 경계: 직전 문자가 단어 문자면 멘션이 아님(email local part 등).
    const prev = i > 0 ? text[i - 1] : '';
    if (prev !== '' && /[A-Za-z0-9_]/.test(prev)) {
      i += 1;
      continue;
    }
    // 이 `@` 에서 가장 긴 후보를 시도한다.
    let matched: RoleMentionMatch<T> | null = null;
    for (const c of sorted) {
      const body = text.slice(i + 1, i + 1 + c.trimmed.length);
      if (body.toLowerCase() !== c.trimmed.toLowerCase()) continue;
      // 역할명 뒤 경계: 다음 문자가 단어 문자면 부분 매칭이므로 거부.
      const after = text[i + 1 + c.trimmed.length] ?? '';
      if (after !== '' && /[A-Za-z0-9_]/.test(after)) continue;
      matched = { start: i, end: i + 1 + c.trimmed.length, value: c.value };
      break;
    }
    if (matched) {
      matches.push(matched);
      i = matched.end; // 소비 — 더 짧은 prefix 가 이 구간을 재매칭하지 못한다.
    } else {
      i += 1;
    }
  }
  return matches;
}

/**
 * fenced code block(```...```)과 inline code(`...`) 영역의 [start, end) 범위를
 * 수집한다. mention-normalizer 의 collectCodeSpans 와 동일 시맨틱(라인 기반 펜스
 * + 문자 기반 백틱). 닫히지 않은 펜스/백틱은 문서 끝까지 코드로 간주한다.
 */
function collectCodeSpans(raw: string): CodeSpan[] {
  const spans: CodeSpan[] = [];
  let i = 0;
  const n = raw.length;
  while (i < n) {
    if (isFenceAt(raw, i)) {
      const fenceStart = i;
      let j = lineEnd(raw, i);
      while (j < n) {
        const ls = j;
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
    if (raw[i] === '`') {
      const codeStart = i;
      let k = i + 1;
      while (k < n && raw[k] !== '`' && raw[k] !== '\n') k += 1;
      if (k < n && raw[k] === '`') {
        spans.push({ start: codeStart, end: k + 1 });
        i = k + 1;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return spans;
}

function isFenceAt(raw: string, i: number): boolean {
  const atLineStart = i === 0 || raw[i - 1] === '\n';
  return atLineStart && raw.startsWith('```', i);
}

function lineEnd(raw: string, i: number): number {
  const nl = raw.indexOf('\n', i);
  return nl === -1 ? raw.length : nl + 1;
}
