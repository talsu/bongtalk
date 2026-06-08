/**
 * FR-MN-10 (Task 066 / S93): 키워드 어절 정확 일치(whole-word) 매처 순수 함수.
 *
 * PRD: "공백 어절 정확 일치(대소문자 무관, 형태소 분석은 Phase 2)". substring 이 아니라
 * 어절(공백 기준 토큰) 경계로 일치해야 한다 — `deploy` 는 "let's deploy now" 에 일치하지만
 * "redeploys" 에는 불일치한다. 다어절 키워드("code review")도 어절 시퀀스로 매칭한다.
 *
 * 구현은 양끝에 sentinel 공백을 둔 단일 공백 정규화 문자열에서 `' ' + kw + ' '` 의 부분
 * 문자열 포함 여부로 어절 경계를 판정한다(정규식 escape·ReDoS 회피 · O(n) includes).
 * 구두점은 토큰의 일부로 남으므로(strict whitespace 정의) `deploy!` 는 `deploy` 와 별개
 * 토큰이 되어 불일치한다(ADR Non-goal — 구두점 인접 어절 비일치).
 *
 * mention-scan.processor 와 단위 테스트가 동일 함수를 공유해 매칭 로직 divergence 를 막는다.
 */

/** 키워드/본문을 어절 경계 매칭용으로 정규화한다(소문자 · 연속 공백 단일화 · trim). */
function normalizeWords(text: string): string {
  return text.toLowerCase().split(/\s+/).filter(Boolean).join(' ');
}

/**
 * 본문 contentPlain 을 어절 경계 매칭용 sentinel 문자열로 만든다. 양끝 공백으로 감싸
 * `' ' + kw + ' '` includes 가 첫/마지막 어절도 경계로 인식하게 한다. 빈 본문이면 빈 문자열.
 */
export function buildBoundedText(contentPlain: string | null | undefined): string {
  const norm = normalizeWords(contentPlain ?? '');
  if (norm === '') return '';
  return ` ${norm} `;
}

/**
 * sentinel-bounded 본문에 키워드가 어절 정확 일치(whole-word)로 포함되는지 판정한다.
 * 키워드는 호출부에서 정규화하지 않아도 되도록 내부에서 normalize 한다(trim·소문자·공백
 * 단일화). 정규화 후 빈 키워드("" · 공백뿐)는 항상 false(빈 키워드는 매칭하지 않음).
 *
 * @param boundedText buildBoundedText 가 만든 ` ...본문... ` (빈 문자열이면 항상 false).
 * @param keyword     사용자 키워드 원문(trim/대소문자/내부공백 정규화는 내부 수행).
 */
export function matchesKeyword(boundedText: string, keyword: string): boolean {
  if (boundedText === '') return false;
  const kw = normalizeWords(keyword);
  if (kw === '') return false;
  return boundedText.includes(` ${kw} `);
}

/** mention-scan 워커가 매칭하는 watcher 한 명의 입력(키워드 목록 보유자). */
export interface KeywordWatcher {
  userId: string;
  keywords: string[];
}

/**
 * 본문에 대해 watcher 목록을 스캔해, 키워드가 1개라도 어절 정확 일치한 watcher 의 userId
 * 집합을 돌려준다(순수 함수 · DB/IO 없음). 워커는 후보 watcher 를 DB 에서 조회한 뒤 이
 * 함수로 매칭만 위임하고, 가시성/게이트/기록은 별도로 수행한다. 빈 본문/빈 watcher 면 빈 Set.
 */
export function scanKeywords(
  contentPlain: string | null | undefined,
  watchers: readonly KeywordWatcher[],
): Set<string> {
  const matched = new Set<string>();
  const bounded = buildBoundedText(contentPlain);
  if (bounded === '') return matched;
  for (const watcher of watchers) {
    for (const keyword of watcher.keywords) {
      if (matchesKeyword(bounded, keyword)) {
        matched.add(watcher.userId);
        break;
      }
    }
  }
  return matched;
}
