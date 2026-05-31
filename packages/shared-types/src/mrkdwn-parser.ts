import {
  MRKDWN_PARSE_LIMITS,
  type MrkdwnParseErrorCode,
  mentionUserRe,
  MENTION_CHANNEL_RE,
  MENTION_ROLE_RE,
} from './mrkdwn';
import {
  isSafeLinkUrl,
  type InlineNode,
  type RichTextNode,
  type RichTextRoot,
  type TextMark,
  type TextNode,
  type ListItem,
} from './mrkdwn-ast';

/**
 * S02 — qufox mrkdwn 송수신 코어 파서 (FR-MSG-01 / FR-MSG-20 / FR-MSG-23).
 *
 * contentRaw(원본 mrkdwn) → contentAst(rich_text AST) + contentPlain(평문)
 * 파이프라인의 단일 출처입니다. 서버(messages.service)가 저장 시 호출하고,
 * 클라이언트 렌더러는 그 결과(contentAst)를 렌더합니다.
 *
 * 보안/안정성:
 *   - 이 파서는 **선형 시간 단일 패스** 스캐너입니다. 정규식 백트래킹을
 *     쓰지 않으므로 carryover(S00)에서 지적된 fencePattern O(n^2) ReDoS 가
 *     구조적으로 불가능합니다. 멘션 토큰만 앵커드/단순 수량자 정규식을
 *     씁니다(ReDoS 안전).
 *   - 중첩 인라인 마크 깊이를 MAX_DEPTH 로, 전체 노드 수를 MAX_NODES 로
 *     enforce 합니다(FR-MSG-23). 초과 시 MrkdwnParseError 를 던집니다.
 *   - link.url 은 isSafeLinkUrl 로 sanitize 합니다 — `javascript:` / `data:`
 *     같은 활성 스킴은 링크 노드로 만들지 않고 일반 텍스트로 흘립니다
 *     (FR-MSG-20). HTML escape 는 AST 가 신뢰 경계이므로 렌더러가 담당하며,
 *     파서는 원본 문자를 그대로 text 노드에 보존합니다(`<script>` 도 literal).
 *
 * 주: AST 가 신뢰 경계라는 설계 때문에 파서는 HTML escape 를 하지 않습니다.
 * 모든 렌더 경로(React 렌더러)는 자동 escape 되며 raw HTML 을 주입하지
 * 않습니다.
 */

/** 파서 한도 위반 도메인 에러. code 는 호출측(api)에서 HttpException 으로 매핑. */
export class MrkdwnParseError extends Error {
  readonly code: MrkdwnParseErrorCode | 'MESSAGE_TOO_LONG';
  constructor(code: MrkdwnParseErrorCode | 'MESSAGE_TOO_LONG', message: string) {
    super(message);
    this.name = 'MrkdwnParseError';
    this.code = code;
  }
}

export interface ParsedMrkdwn {
  ast: RichTextRoot;
  plain: string;
}

/**
 * FR-MSG-03 / FR-MSG-20 — contentPlain 4,000자 한도(애플리케이션 계층
 * enforce). 초과 시 MESSAGE_TOO_LONG. 길이는 코드포인트가 아니라 UTF-16
 * 길이(`String.length`)로 측정합니다 — DB TEXT 제약과 동일 기준.
 */
export function enforceContentLength(plain: string): void {
  if (plain.length > MRKDWN_PARSE_LIMITS.MAX_PLAIN_LENGTH) {
    throw new MrkdwnParseError(
      'MESSAGE_TOO_LONG',
      `message exceeds ${MRKDWN_PARSE_LIMITS.MAX_PLAIN_LENGTH} characters`,
    );
  }
}

/**
 * FR-MSG-23 — contentAst JSON 64KB 한도. 직렬화 바이트 수(UTF-8)로
 * 측정합니다. 초과 시 PARSE_AST_TOO_LARGE.
 */
export function enforceAstByteSize(ast: unknown): void {
  const bytes = utf8ByteLength(JSON.stringify(ast));
  if (bytes > MRKDWN_PARSE_LIMITS.MAX_AST_BYTES) {
    throw new MrkdwnParseError(
      'PARSE_AST_TOO_LARGE',
      `contentAst ${bytes} bytes exceeds ${MRKDWN_PARSE_LIMITS.MAX_AST_BYTES}`,
    );
  }
}

function utf8ByteLength(s: string): number {
  // TextEncoder is available in Node 18+ and all modern browsers; falls
  // back to a manual count when (rarely) absent.
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(s).length;
  }
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/** 파서 내부 노드 카운터/타임아웃을 공유하는 스캔 상태. */
interface ScanState {
  nodeCount: number;
  deadline: number;
}

function bumpNode(state: ScanState): void {
  state.nodeCount += 1;
  if (state.nodeCount > MRKDWN_PARSE_LIMITS.MAX_NODES) {
    throw new MrkdwnParseError(
      'PARSE_NODE_LIMIT',
      `AST node count exceeds ${MRKDWN_PARSE_LIMITS.MAX_NODES}`,
    );
  }
  // 타임아웃 가드 — 본 파서는 선형이라 사실상 걸리지 않지만 안전망입니다.
  if (Date.now() > state.deadline) {
    throw new MrkdwnParseError('PARSE_TIMEOUT', 'mrkdwn parse exceeded time budget');
  }
}

/**
 * qufox mrkdwn → rich_text AST + plain projection.
 * 빈/공백 입력은 빈 root 를 반환합니다(SYSTEM 메시지·빈 본문 forward-compat).
 */
export function parseMrkdwn(raw: string): ParsedMrkdwn {
  const state: ScanState = {
    nodeCount: 1, // root
    deadline: Date.now() + MRKDWN_PARSE_LIMITS.TIMEOUT_MS,
  };
  const nodes = parseBlocks(raw, state);
  const ast: RichTextRoot = { type: 'root', nodes };
  const plain = collapsePlain(astToPlain(ast));
  return { ast, plain };
}

// ── 블록 파싱 ────────────────────────────────────────────────────────────────
// 한 줄씩 스캔하며 fenced code / blockquote / list / paragraph 를 구분합니다.
// fenced code 안은 마크업/멘션을 일절 파싱하지 않습니다(literal).

const FENCE_RE = /^```([a-zA-Z0-9_+-]*)\s*$/;
const ORDERED_RE = /^(\d{1,9})\.\s+(.*)$/;
const UNORDERED_RE = /^[-*]\s+(.*)$/;
const QUOTE_RE = /^>\s?(.*)$/;

function parseBlocks(raw: string, state: ScanState): RichTextNode[] {
  const lines = raw.split('\n');
  const out: RichTextNode[] = [];
  let i = 0;
  while (i < lines.length) {
    bumpNode(state);
    const line = lines[i];

    // ---- fenced code block
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const lang = fence[1] || null;
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1; // consume closing fence
      out.push({ type: 'code_block', code: body.join('\n'), lang });
      continue;
    }

    // ---- blockquote (single or multi-line `> ` run)
    if (QUOTE_RE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        inner.push(QUOTE_RE.exec(lines[i])![1]);
        i += 1;
      }
      out.push({ type: 'blockquote', nodes: parseInline(inner.join('\n'), state) });
      continue;
    }

    // ---- list (consecutive ordered OR unordered items)
    if (ORDERED_RE.test(line) || UNORDERED_RE.test(line)) {
      const ordered = ORDERED_RE.test(line);
      const items: ListItem[] = [];
      while (i < lines.length) {
        const re = ordered ? ORDERED_RE : UNORDERED_RE;
        const m = re.exec(lines[i]);
        if (!m) break;
        bumpNode(state);
        const itemText = ordered ? m[2] : m[1];
        items.push({ nodes: parseInline(itemText, state) });
        i += 1;
      }
      out.push({ type: 'list', ordered, indent: 0, items });
      continue;
    }

    // ---- paragraph: gather consecutive non-block lines
    const para: string[] = [];
    while (
      i < lines.length &&
      !FENCE_RE.test(lines[i]) &&
      !QUOTE_RE.test(lines[i]) &&
      !ORDERED_RE.test(lines[i]) &&
      !UNORDERED_RE.test(lines[i])
    ) {
      para.push(lines[i]);
      i += 1;
    }
    const joined = para.join('\n');
    // skip pure-empty paragraphs so blank lines don't spawn empty nodes
    if (joined.trim().length === 0) continue;
    out.push({ type: 'paragraph', nodes: parseInline(joined, state) });
  }
  return out;
}

// ── 인라인 파싱 (단일 패스 스캐너) ───────────────────────────────────────────
// 마크 스택을 유지하며 char 단위로 전진합니다. 정규식 백트래킹 없음 →
// 선형 시간. 멘션 토큰은 앵커드 정규식으로 매칭합니다.

interface InlineMarker {
  open: string;
  mark: TextMark;
}

// 길이 내림차순으로 정렬해 `**` / `~~` / `||` 가 `*` / `~` / `|` 보다 먼저
// 매칭되게 합니다.
const INLINE_MARKERS: InlineMarker[] = [
  { open: '~~', mark: 'strike' },
  { open: '||', mark: 'spoiler' },
  { open: '**', mark: 'bold' },
  { open: '*', mark: 'bold' }, // Slack-style single asterisk = bold
  { open: '_', mark: 'italic' },
  { open: '`', mark: 'code' },
];

function matchMarker(text: string, pos: number): InlineMarker | null {
  for (const m of INLINE_MARKERS) {
    if (text.startsWith(m.open, pos)) return m;
  }
  return null;
}

const URL_RE = /^https?:\/\/[^\s<>]+[^\s<>.,;:!?'"()\]]/;
const MD_LINK_RE = /^\[([^\]\n]*)\]\(([^()\s]+)\)/;

function parseInline(text: string, state: ScanState): InlineNode[] {
  enforceInlineMarkerDepth(text);
  return parseInlineRun(text, [], state);
}

/**
 * FR-MSG-23 — 인라인 마크 중첩 깊이 사전 가드. `*_*_*_…` 처럼 마커 토큰이
 * 거의 글자 없이 연속으로 밀집하는 ReDoS/스택 공격 입력을 한도(MAX_DEPTH)
 * 초과로 거부합니다. 양끝에서 같은 위치로 수렴하는 마커 토큰의 연속 개수를
 * 깊이로 측정합니다 — `*x*`(1) · `*_x_*`(2) · `*_*_x_*_*`(4) …
 *
 * 선형 스캔(백트래킹 없음). 정상 메시지는 마커 사이에 본문이 있어 이 가드에
 * 걸리지 않습니다.
 */
function enforceInlineMarkerDepth(text: string): void {
  let lead = 0;
  let i = 0;
  while (i < text.length) {
    const m = matchMarker(text, i);
    if (!m) break;
    lead += 1;
    i += m.open.length;
  }
  let trail = 0;
  let j = text.length;
  while (j > i) {
    // 끝에서부터 동일 토큰 연속을 셉니다.
    let matched: InlineMarker | null = null;
    for (const mk of INLINE_MARKERS) {
      if (j - mk.open.length >= i && text.startsWith(mk.open, j - mk.open.length)) {
        matched = mk;
        break;
      }
    }
    if (!matched) break;
    trail += 1;
    j -= matched.open.length;
  }
  const depth = Math.min(lead, trail);
  if (depth > MRKDWN_PARSE_LIMITS.MAX_DEPTH) {
    throw new MrkdwnParseError(
      'PARSE_DEPTH_EXCEEDED',
      `inline nesting depth ${depth} exceeds ${MRKDWN_PARSE_LIMITS.MAX_DEPTH}`,
    );
  }
}

/**
 * 인라인 런 파서. `activeMarks` 는 현재 열려 있는 마크들(중첩). 깊이는
 * activeMarks.length 로 측정해 MAX_DEPTH 를 enforce 합니다(FR-MSG-23).
 */
function parseInlineRun(text: string, activeMarks: TextMark[], state: ScanState): InlineNode[] {
  if (activeMarks.length > MRKDWN_PARSE_LIMITS.MAX_DEPTH) {
    throw new MrkdwnParseError(
      'PARSE_DEPTH_EXCEEDED',
      `inline nesting exceeds ${MRKDWN_PARSE_LIMITS.MAX_DEPTH}`,
    );
  }
  const out: InlineNode[] = [];
  let buf = '';
  let pos = 0;

  const flush = (): void => {
    if (buf.length === 0) return;
    bumpNode(state);
    const node: TextNode = { type: 'text', text: buf, marks: [...activeMarks] };
    out.push(node);
    buf = '';
  };

  while (pos < text.length) {
    // periodic timeout/node check on the hot loop
    if ((pos & 0x3ff) === 0 && Date.now() > state.deadline) {
      throw new MrkdwnParseError('PARSE_TIMEOUT', 'mrkdwn parse exceeded time budget');
    }
    const rest = text.slice(pos);

    // --- mention_user @{cuid2}
    const userRe = mentionUserRe();
    userRe.lastIndex = 0;
    const um = userRe.exec(rest);
    if (um && um.index === 0) {
      flush();
      bumpNode(state);
      out.push({ type: 'mention_user', userId: um[1] });
      pos += um[0].length;
      continue;
    }

    // --- mention_channel <#cuid2>
    const chRe = new RegExp(MENTION_CHANNEL_RE.source);
    const cm = chRe.exec(rest);
    if (cm && cm.index === 0) {
      flush();
      bumpNode(state);
      out.push({ type: 'mention_channel', channelId: cm[1] });
      pos += cm[0].length;
      continue;
    }

    // --- mention_role <@&cuid2>
    const roleRe = new RegExp(MENTION_ROLE_RE.source);
    const rm = roleRe.exec(rest);
    if (rm && rm.index === 0) {
      flush();
      bumpNode(state);
      out.push({ type: 'mention_role', roleId: rm[1] });
      pos += rm[0].length;
      continue;
    }

    // --- markdown link [label](url)
    const link = MD_LINK_RE.exec(rest);
    if (link) {
      const url = link[2];
      if (isSafeLinkUrl(url)) {
        flush();
        bumpNode(state);
        out.push({ type: 'link', url, text: link[1] || null });
        pos += link[0].length;
        continue;
      }
      // unsafe scheme → keep the whole token as literal text (FR-MSG-20)
      buf += link[0];
      pos += link[0].length;
      continue;
    }

    // --- bare url
    const bare = URL_RE.exec(rest);
    if (bare) {
      flush();
      bumpNode(state);
      out.push({ type: 'link', url: bare[0], text: null });
      pos += bare[0].length;
      continue;
    }

    // --- inline marker (open → find matching close on this run)
    const marker = matchMarker(text, pos);
    if (marker) {
      const closeIdx = findClose(text, pos + marker.open.length, marker.open);
      if (closeIdx !== -1) {
        flush();
        const innerRaw = text.slice(pos + marker.open.length, closeIdx);
        if (marker.mark === 'code') {
          // inline code: contents are literal — no nested parsing.
          bumpNode(state);
          out.push({ type: 'text', text: innerRaw, marks: [...activeMarks, 'code'] });
        } else {
          const inner = parseInlineRun(innerRaw, [...activeMarks, marker.mark], state);
          out.push(...inner);
        }
        pos = closeIdx + marker.open.length;
        continue;
      }
      // no close → literal marker char(s)
    }

    buf += text[pos];
    pos += 1;
  }
  flush();
  return out;
}

/**
 * 같은 마커의 닫힘 위치를 찾습니다(non-greedy — 가장 가까운 동일 토큰).
 * `*a* *b*` 처럼 인접한 두 span 이 서로 침범하지 않게 보장합니다. 선형
 * 스캔(백트래킹 없음). 줄바꿈을 넘지 않으며, 닫힘이 없으면 -1.
 */
function findClose(text: string, from: number, open: string): number {
  let i = from;
  while (i < text.length) {
    if (text[i] === '\n') return -1;
    if (text.startsWith(open, i)) return i;
    i += 1;
  }
  return -1;
}

// ── plain projection ─────────────────────────────────────────────────────────

function astToPlain(node: RichTextNode | RichTextRoot): string {
  switch (node.type) {
    case 'root':
    case 'paragraph':
    case 'heading':
    case 'subtext':
    case 'blockquote':
      return node.nodes.map(astToPlain).join('');
    case 'list':
      return node.items.map((it) => it.nodes.map(astToPlain).join('')).join(' ');
    case 'code_block':
      return node.code;
    case 'divider':
      return '';
    case 'text':
      return node.text;
    case 'mention_user':
    case 'mention_channel':
    case 'mention_role':
      // plain projection drops mention sigils — search/notification text
      // doesn't need the raw token, and the id is meaningless to FTS.
      return '';
    case 'emoji':
      return `:${node.name}:`;
    case 'link':
      return node.text ?? node.url;
    default:
      return '';
  }
}

function collapsePlain(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
