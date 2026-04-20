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
