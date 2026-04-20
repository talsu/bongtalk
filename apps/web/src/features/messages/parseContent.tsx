import type { ReactNode } from 'react';

/**
 * Minimal message content renderer — three rules only, chosen by the
 * task-018 mockup (Full Chat Mockup lines 591-599):
 *
 *   1. Triple-backtick fenced blocks → <pre class="qf-codeblock"><code>…</code></pre>
 *   2. Single-backtick inline code   → <code class="qf-code-inline">…</code>
 *   3. @username mentions             → <span class="qf-mention">@username</span>
 *
 * Bold / italic / heading / list / link parsing is intentionally OUT —
 * importing a full markdown parser (markdown-it is ~40 KB gzipped) is
 * over-provisioned for a closed-beta app where the DS only prescribes
 * those three patterns. The Shell chunk currently sits at ~18 KB gzip
 * against an 80 KB budget, so adding markdown-it would be fine on paper
 * — the decision here is scope, not bundle.
 *
 * All output is plain React nodes (no dangerouslySetInnerHTML), so the
 * parser can't emit markup the caller didn't intend. URLs inside
 * mentions / code are not auto-linked.
 */
export function renderMessageContent(content: string): ReactNode[] {
  if (!content) return [];

  // Split on fenced code first so inline rules don't run inside blocks.
  const fencePattern = /```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g;
  const out: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  let match: RegExpExecArray | null;
  while ((match = fencePattern.exec(content)) !== null) {
    if (match.index > lastIndex) {
      out.push(...renderInline(content.slice(lastIndex, match.index), `pre-${key++}`));
    }
    const lang = match[1];
    const body = match[2];
    out.push(
      <pre key={`code-${key++}`} className="qf-codeblock">
        {lang ? <span className="qf-codeblock__lang">{lang}</span> : null}
        <code>{body}</code>
      </pre>,
    );
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < content.length) {
    out.push(...renderInline(content.slice(lastIndex), `tail-${key++}`));
  }
  return out;
}

/**
 * Inline pass. Walks the string once, emitting <code class="qf-code-inline">
 * for backtick-wrapped spans and <span class="qf-mention"> for
 * `@username` tokens (username = word chars + `_`, 1–32 chars, matching
 * the user-creation validation in shared-types). Everything else is
 * plain text joined with <br> on newlines.
 */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Combined regex — alternation means we consume whichever comes first.
  const pattern = /`([^`\n]+)`|@([A-Za-z0-9_]{1,32})/g;
  let cursor = 0;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > cursor) {
      out.push(...splitLines(text.slice(cursor, m.index), `${keyPrefix}-t-${idx++}`));
    }
    if (m[1] !== undefined) {
      out.push(
        <code key={`${keyPrefix}-c-${idx++}`} className="qf-code-inline">
          {m[1]}
        </code>,
      );
    } else if (m[2] !== undefined) {
      out.push(
        <span key={`${keyPrefix}-m-${idx++}`} className="qf-mention">
          @{m[2]}
        </span>,
      );
    }
    cursor = m.index + m[0].length;
  }
  if (cursor < text.length) {
    out.push(...splitLines(text.slice(cursor), `${keyPrefix}-t-${idx++}`));
  }
  return out;
}

function splitLines(text: string, keyPrefix: string): ReactNode[] {
  if (!text.includes('\n')) return [text];
  const parts = text.split('\n');
  const out: ReactNode[] = [];
  parts.forEach((p, i) => {
    if (p) out.push(p);
    if (i < parts.length - 1) out.push(<br key={`${keyPrefix}-br-${i}`} />);
  });
  return out;
}
