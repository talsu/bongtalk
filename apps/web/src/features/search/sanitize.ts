/**
 * Task-015-C: mark-only sanitizer for search snippets.
 *
 * The server ALREADY HTML-escapes `m.content` inside SQL (three
 * `replace()` calls) before passing it to ts_headline + only uses
 * `<mark>…</mark>` as StartSel/StopSel, so the wire payload is
 * already safe. This client-side pass is defense-in-depth: it drops
 * any unexpected tag the wire might carry while leaving the already-
 * escaped entities (`&amp;`, `&lt;`, etc.) intact — no double
 * escaping so the user sees the right characters.
 *
 * Strategy:
 *   1. Find every `<…>` in the input.
 *   2. If the tag is exactly `<mark>` or `</mark>`, keep it.
 *   3. Otherwise, replace it with the HTML-escaped form so the
 *      browser renders the literal angle brackets instead of a tag.
 * A bare `&` never re-escapes — the server's escape pass (or the
 * user's own `&amp;` input) reaches the DOM as-is.
 *
 * Task-015 reviewer LOW-2 closure (fix-forward during the same
 * review cycle) — the earlier blanket escape-then-restore pass
 * double-escaped `&amp;` into `&amp;amp;`.
 */
export function markOnlyHtml(raw: string): string {
  return raw.replace(/<[^>]*>/g, (tag) => {
    if (tag === '<mark>' || tag === '</mark>') return tag;
    // Any other tag — escape it so it renders as text, not HTML.
    return tag.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  });
}

/**
 * task-047 iter1 (J4): 검색 결과 snippet 안에서 mention (`@user` /
 * `#channel`) 과 inline code (`` `code` ``) 를 시각적으로 강조.
 *
 * 입력은 markOnlyHtml 통과 후 string (HTML-escaped + `<mark>` 만 허용).
 * 출력은 추가로 `<span class="qf-mention">@user</span>`,
 * `<span class="qf-channel">#channel</span>`, `<code>`...`</code>`
 * 태그를 삽입한 string.
 *
 * 보안: mark / code / span 만 허용. 추가 태그가 escaping 우회 못 하도록
 * 입력은 markOnlyHtml 가 사전 처리되어 있어야 함 (caller 보장).
 */
const MENTION_USER_RE = /(?<![A-Za-z0-9_])@([A-Za-z0-9_.-]{2,32})/g;
const MENTION_CHANNEL_RE = /(?<![A-Za-z0-9_])#([a-z0-9][a-z0-9_-]{0,31})/g;
const INLINE_CODE_RE = /`([^`<>]+)`/g;

export function highlightSnippet(htmlSafe: string): string {
  // Inline code 먼저 (mention regex 가 backtick 안에 들어간 텍스트는 안 잡도록).
  let result = htmlSafe.replace(INLINE_CODE_RE, (_m, code: string) => {
    return `<code class="qf-search-code">${code}</code>`;
  });
  result = result.replace(MENTION_USER_RE, (_m, name: string) => {
    return `<span class="qf-mention">@${name}</span>`;
  });
  result = result.replace(MENTION_CHANNEL_RE, (_m, name: string) => {
    return `<span class="qf-channel-ref">#${name}</span>`;
  });
  return result;
}

/**
 * mark + code + qf-mention + qf-channel-ref span 만 허용하는 sanitizer.
 * markOnlyHtml + highlightSnippet 직후 최종 단계에서 호출.
 */
export function searchSnippetHtml(raw: string): string {
  return highlightSnippet(markOnlyHtml(raw));
}
