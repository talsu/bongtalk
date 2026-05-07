import type { ReactNode } from 'react';
import type { CustomEmoji } from '../emojis/api';

/**
 * Message content renderer — task-044 iteration 1 으로 markdown 인라인
 * (bold/italic/strike) + line-prefix block quote 를 추가했습니다.
 *
 *   1. Triple-backtick fenced blocks → <pre class="qf-codeblock"><code>…</code></pre>
 *   2. Single-backtick inline code   → <code class="qf-code-inline">…</code>
 *   3. @username mentions             → <span class="qf-mention">@username</span>
 *   4. task-037-D custom emoji        → <img class="qf-emoji-custom"> for
 *      `:name:` tokens that match a workspace emoji.
 *   5. URLs http(s)                   → <a target="_blank" rel="noopener noreferrer">
 *   6. task-044 markdown:
 *      - **bold**           → <strong class="font-semibold">
 *      - *em* / _em_         → <em class="italic">
 *      - ~~strike~~          → <s class="line-through">
 *      - 라인 프리픽스 `> ` → <blockquote class="…border-l-2…">
 *
 * DS 4 파일 (`tokens.css` / `components.css` / `mobile.css` / `icons.css`)
 * 은 수정하지 않습니다. semantic 태그 + Tailwind utility (모두 DS 토큰
 * alias 로 라우트) 만 사용합니다. 외부 markdown 파서 도입 X.
 *
 * 출력은 plain React nodes 만 — `dangerouslySetInnerHTML` 사용 안 함.
 */
export function renderMessageContent(
  content: string,
  customEmojis?: Map<string, CustomEmoji>,
): ReactNode[] {
  if (!content) return [];

  // Split on fenced code first so inline rules don't run inside blocks.
  const fencePattern = /```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g;
  const out: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  let match: RegExpExecArray | null;
  while ((match = fencePattern.exec(content)) !== null) {
    if (match.index > lastIndex) {
      out.push(
        ...renderQuotedSegments(
          content.slice(lastIndex, match.index),
          `pre-${key++}`,
          customEmojis,
        ),
      );
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
    out.push(...renderQuotedSegments(content.slice(lastIndex), `tail-${key++}`, customEmojis));
  }
  return out;
}

/**
 * 라인 프리픽스 `> ` 를 감지해 연속 라인을 하나의 blockquote 로 묶고,
 * 비-quote 세그먼트는 inline pass 로 전달합니다. fenced 외부에서만
 * 호출됩니다.
 */
function renderQuotedSegments(
  text: string,
  keyPrefix: string,
  customEmojis?: Map<string, CustomEmoji>,
): ReactNode[] {
  if (!text) return [];
  // 라인을 보존해야 inline 의 splitLines 가 <br> 를 제대로 만듭니다.
  const lines = text.split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  let segIdx = 0;
  while (i < lines.length) {
    if (isQuoteLine(lines[i])) {
      // quote 블록 누적
      const quoteLines: string[] = [];
      while (i < lines.length && isQuoteLine(lines[i])) {
        quoteLines.push(stripQuotePrefix(lines[i]));
        i += 1;
      }
      const inner = quoteLines.join('\n');
      out.push(
        <blockquote
          key={`${keyPrefix}-q-${segIdx++}`}
          className="my-1 border-l-2 border-border-subtle pl-3 text-text-secondary"
        >
          {renderInline(inner, `${keyPrefix}-qi-${segIdx}`, customEmojis)}
        </blockquote>,
      );
    } else {
      // 비-quote 라인 누적 (다음 quote 가 나올 때까지)
      const plainLines: string[] = [];
      while (i < lines.length && !isQuoteLine(lines[i])) {
        plainLines.push(lines[i]);
        i += 1;
      }
      const inner = plainLines.join('\n');
      if (inner.length > 0) {
        out.push(...renderInline(inner, `${keyPrefix}-p-${segIdx++}`, customEmojis));
      }
    }
  }
  return out;
}

function isQuoteLine(line: string): boolean {
  // `>` 또는 `> ` 시작. 여러 `>` (중첩) 도 단일 quote 로 평탄화합니다.
  return /^>\s?/.test(line);
}

function stripQuotePrefix(line: string): string {
  return line.replace(/^>\s?/, '');
}

/**
 * task-045 iter6: URL 추출 유틸. MessageItem 이 LinkPreview 카드를
 * 본문 아래 렌더할 때 사용. inline regex 와 동일한 패턴 + 동일한
 * trailing-punct 보호. fenced 안의 URL 은 추출 X — fenced 외부
 * 세그먼트만 스캔.
 *
 * Discord 정책: 메시지당 최대 3 카드. 더 많은 URL 이 있어도 처음 3
 * 개만 미리보기 시도.
 */
const URL_EXTRACT_RE = /(https?:\/\/[^\s<>]+[^\s<>.,;:!?'"()\]])/g;
const FENCE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`\n]+`/g;
const QUOTE_LINE_RE = /^>\s?/;
export const LINK_PREVIEW_CAP_PER_MESSAGE = 3;

export function extractMessageUrls(content: string): string[] {
  if (!content) return [];
  // fenced 와 inline code 영역을 zero 로 마스킹 — 그 안의 URL 은
  // 미리보기 카드 트리거 안 함. quote prefix 도 강조 무관.
  const masked = content
    .replace(FENCE_RE, (m) => ' '.repeat(m.length))
    .replace(INLINE_CODE_RE, (m) => ' '.repeat(m.length))
    .split('\n')
    .map((line) => (QUOTE_LINE_RE.test(line) ? line.replace(QUOTE_LINE_RE, '') : line))
    .join('\n');
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of masked.matchAll(URL_EXTRACT_RE)) {
    const url = m[1];
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= LINK_PREVIEW_CAP_PER_MESSAGE) break;
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
function renderInline(
  text: string,
  keyPrefix: string,
  customEmojis?: Map<string, CustomEmoji>,
): ReactNode[] {
  const out: ReactNode[] = [];
  // Combined regex — alternation means we consume whichever comes first.
  // Mention regex matches the shared-types username rule `[a-zA-Z0-9_.-]+`
  // (3–32 chars per shared-types, but we allow the shorter 1+ match so a
  // user typing `@a` still sees the intermediate pill). Drift with the
  // server-side mention-extractor was caught by task-018 reviewer HIGH-1.
  //
  // URL matcher: http(s) only, stops at whitespace + a trailing-punct
  // guard so "https://example.com." renders without the trailing dot
  // swallowed into the href. Rich embed cards remain a backend follow-up
  // (OpenGraph scraper with SSRF guards); the DS `.qf-embed` card stays
  // unused until that ships.
  //
  // task-037-D: `:name:` custom emoji — same name charset the API
  // validates (`[a-z0-9_]{2,32}`). Unknown names pass through as text
  // so when an admin deletes an emoji the old messages still read.
  // task-044: markdown bold (`**…**`) / strike (`~~…~~`) / italic
  // (`*…*` 또는 `_…_`). 우선순위는 alternation 순서로 보장 — `**` 가
  // `*` 보다 먼저 매칭되어야 bold 가 italic 으로 잘리지 않습니다.
  // Bold inner allows single `*` (so nested italic survives as raw text
  // inside the bold span without breaking the match): `(?:[^*\n]|\*(?!\*))+?`.
  const pattern =
    /`([^`\n]+)`|@([A-Za-z0-9_.-]{1,32})|(https?:\/\/[^\s<>]+[^\s<>.,;:!?'"()\]])|:([a-z0-9_]{2,32}):|\*\*((?:[^*\n]|\*(?!\*))+?)\*\*|~~([^~\n]+?)~~|\*([^*\n]+?)\*|_([^_\n]+?)_/g;
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
    } else if (m[3] !== undefined) {
      out.push(
        <a
          key={`${keyPrefix}-u-${idx++}`}
          href={m[3]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
        >
          {m[3]}
        </a>,
      );
    } else if (m[4] !== undefined) {
      const ce = customEmojis?.get(m[4]);
      if (ce) {
        out.push(
          <img
            key={`${keyPrefix}-e-${idx++}`}
            src={ce.url}
            alt={`:${ce.name}:`}
            title={`:${ce.name}:`}
            className="qf-emoji-custom"
            style={{
              display: 'inline-block',
              width: 20,
              height: 20,
              verticalAlign: 'text-bottom',
              objectFit: 'contain',
            }}
          />,
        );
      } else {
        out.push(...splitLines(m[0], `${keyPrefix}-t-${idx++}`));
      }
    } else if (m[5] !== undefined) {
      out.push(
        <strong key={`${keyPrefix}-b-${idx++}`} className="font-semibold">
          {m[5]}
        </strong>,
      );
    } else if (m[6] !== undefined) {
      out.push(
        <s key={`${keyPrefix}-s-${idx++}`} className="line-through">
          {m[6]}
        </s>,
      );
    } else if (m[7] !== undefined) {
      out.push(
        <em key={`${keyPrefix}-i-${idx++}`} className="italic">
          {m[7]}
        </em>,
      );
    } else if (m[8] !== undefined) {
      out.push(
        <em key={`${keyPrefix}-iu-${idx++}`} className="italic">
          {m[8]}
        </em>,
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
