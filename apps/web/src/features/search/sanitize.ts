/**
 * Task-015-C: mark-only sanitizer for search snippets.
 *
 * The backend already HTML-escapes content before passing it to
 * Postgres ts_headline + only uses `<mark>…</mark>` as its
 * StartSel/StopSel. This client-side pass is defense-in-depth — if
 * anything ever slips through (a future config change, a test
 * fixture, a bug) this util reduces it to "nothing but mark tags".
 *
 * Whitelist approach: escape EVERY angle bracket, then selectively
 * restore the two allowed tags. No regex for HTML parsing surface —
 * just two literal `replace` passes over a fully-escaped string.
 */
export function markOnlyHtml(raw: string): string {
  const escaped = raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Restore only the exact marker strings we emit. `&lt;mark&gt;`
  // becomes `<mark>`; anything else stays escaped.
  return escaped
    .replace(/&amp;lt;mark&amp;gt;/g, '<mark>')
    .replace(/&amp;lt;\/mark&amp;gt;/g, '</mark>')
    .replace(/&lt;mark&gt;/g, '<mark>')
    .replace(/&lt;\/mark&gt;/g, '</mark>');
}
