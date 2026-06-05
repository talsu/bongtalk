/**
 * S83a (D15 / FR-KS-05): composer 마크다운 단축키용 순수 선택영역 래핑 헬퍼.
 *
 * 선택 텍스트를 `before … after` 로 감싸고 새 selection 범위를 돌려준다. 선택이 없으면
 * (start === end) 마커만 삽입하고 커서를 마커 사이에 둔다(빈 선택은 sel='' 이라 동일 식으로
 * 처리됨 — newStart === newEnd === start + before.length).
 *
 * 마커는 mrkdwn-parser INLINE_MARKERS 와 정합한다(`**`=bold·`_`=italic·`~~`=strike·
 * `` ` ``=code). 코드블록은 before='```\n', after='\n```'(앞뒤 개행 포함)로 호출한다.
 *
 * 부수효과 없음 — MessageComposer 가 결과 text 로 draft 를 갱신하고 newStart/newEnd 로
 * textarea selection 을 복원한다(다음 tick).
 */
export interface WrapSelectionArgs {
  text: string;
  start: number;
  end: number;
  before: string;
  after: string;
}

export interface WrapSelectionResult {
  text: string;
  newStart: number;
  newEnd: number;
}

/** start/end 를 [0, len] 으로 클램프하고 start <= end 를 보장한다(범위 역전·초과 방어). */
function normalizeRange(
  text: string,
  rawStart: number,
  rawEnd: number,
): { start: number; end: number } {
  const len = text.length;
  const s = Number.isFinite(rawStart) ? rawStart : 0;
  const e = Number.isFinite(rawEnd) ? rawEnd : 0;
  const start = Math.max(0, Math.min(len, Math.min(s, e)));
  const end = Math.max(0, Math.min(len, Math.max(s, e)));
  return { start, end };
}

export function wrapSelection(args: WrapSelectionArgs): WrapSelectionResult {
  const { text, before, after } = args;
  // 경계 방어: start/end 를 [0, len] 으로 클램프하고 start <= end 보장.
  const { start, end } = normalizeRange(text, args.start, args.end);

  const selected = text.slice(start, end);
  const newText = text.slice(0, start) + before + selected + after + text.slice(end);
  // selection 은 원래 내용(selected) 위에 유지하되 before 길이만큼 뒤로 민다. 빈 선택이면
  // newStart === newEnd 라 커서가 before 와 after 사이에 위치한다.
  const newStart = start + before.length;
  const newEnd = end + before.length;
  return { text: newText, newStart, newEnd };
}

/**
 * S83a 사후 리뷰(reviewer MED): 인라인 마커(bold/italic/strike/code) 멀티라인 래핑.
 *
 * 파서의 인라인 마커는 `\n` 을 넘어 미마감이라(`**a\nb**` 가 리터럴로 렌더), 선택이
 * 여러 줄에 걸치면 각 비어있지 않은 줄을 개별로 `before … after` 로 감싼다(빈 줄은 그대로
 * 둔다). 코드블록(```)은 이 헬퍼를 쓰지 않고 단일 wrapSelection 으로 감싼다(블록 마커는
 * 줄 경계 기반이므로).
 *
 * 선택이 단일 줄(개행 미포함)이면 wrapSelection 과 동일하게 한 번만 감싼다. selection 복원은
 * 치환된 전체 영역(첫 줄의 before 앞 ~ 마지막 줄의 after 뒤)을 가리킨다.
 */
export function wrapSelectionPerLine(args: WrapSelectionArgs): WrapSelectionResult {
  const { text, before, after } = args;
  const { start, end } = normalizeRange(text, args.start, args.end);
  const selected = text.slice(start, end);

  // 단일 줄 선택(또는 빈 선택)은 종전 단일 래핑과 동일.
  if (!selected.includes('\n')) {
    return wrapSelection({ text, start, end, before, after });
  }

  // 멀티라인: 줄 단위로 분해해 비어있지 않은 줄만 개별 래핑한다(빈 줄·공백전용 줄은 그대로).
  const lines = selected.split('\n');
  const wrapped = lines
    .map((line) => (line.trim().length > 0 ? `${before}${line}${after}` : line))
    .join('\n');
  const newText = text.slice(0, start) + wrapped + text.slice(end);
  // selection 은 치환된 전체 영역을 가리킨다(첫 줄 before 앞 ~ 마지막 줄 after 뒤).
  const newStart = start;
  const newEnd = start + wrapped.length;
  return { text: newText, newStart, newEnd };
}

/**
 * S83a (FR-KS-05): composer 포맷 단축키 → (before, after) 마커 매핑. 파서 정합.
 * Ctrl/Cmd+B=bold · Ctrl/Cmd+I=italic · Ctrl+Shift+X=strike · Ctrl+Shift+C=inline code ·
 * Ctrl+Shift+Enter=code block.
 */
export type FormatShortcut = 'bold' | 'italic' | 'strike' | 'code' | 'codeBlock';

export const FORMAT_MARKERS: Record<FormatShortcut, { before: string; after: string }> = {
  bold: { before: '**', after: '**' },
  // ★italic 은 반드시 `_` — 파서에서 `*`/`**` 는 bold 이고 `_` 만 italic.
  italic: { before: '_', after: '_' },
  strike: { before: '~~', after: '~~' },
  code: { before: '`', after: '`' },
  codeBlock: { before: '```\n', after: '\n```' },
};

/**
 * keydown 이벤트를 FormatShortcut 으로 해석한다(매칭 없으면 null). Mac=metaKey·그외=ctrlKey.
 *   Ctrl/Cmd+B → bold · Ctrl/Cmd+I → italic
 *   Ctrl/Cmd+Shift+X → strike · Ctrl/Cmd+Shift+C → code · Ctrl/Cmd+Shift+Enter → codeBlock
 */
export function matchFormatShortcut(e: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): FormatShortcut | null {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod || e.altKey) return null;
  const key = e.key.toLowerCase();
  if (!e.shiftKey) {
    if (key === 'b') return 'bold';
    if (key === 'i') return 'italic';
    return null;
  }
  // Shift 조합
  if (key === 'x') return 'strike';
  if (key === 'c') return 'code';
  if (e.key === 'Enter') return 'codeBlock';
  return null;
}

/**
 * S83c (FR-KS-10): 인라인 포맷 툴바 전용 quote(`> ` 줄 prefix). 선택의 각 줄 앞에 `> ` 를
 * 붙인다(per-line). 파서의 QUOTE_RE(`^>\s?(.*)$`)는 줄 시작 `>` 다음 선택적 공백을 잡고
 * 연속된 `>` 줄을 하나의 blockquote 로 묶으므로(parseBlocks), 각 줄에 `> ` prefix 를 붙이는
 * 것이 정합한다. 빈 줄도 `> ` 를 붙여(빈 인용 줄) 연속 blockquote 가 끊기지 않게 한다 —
 * 가운데 빈 줄에 prefix 가 없으면 파서가 인용을 둘로 쪼갠다.
 *
 * 선택이 없으면(start === end) caret 이 있는 줄 시작에 `> ` 를 삽입한다. selection 은 치환된
 * 전체 줄 영역(첫 줄 prefix 앞 ~ 마지막 줄 끝)을 가리키도록 복원한다.
 */
export function prefixQuote(args: {
  text: string;
  start: number;
  end: number;
}): WrapSelectionResult {
  const { text } = args;
  const { start, end } = normalizeRange(text, args.start, args.end);
  // 선택이 걸친 줄들의 경계를 줄 시작(직전 개행 다음)까지 확장한다 — prefix 는 줄 단위라
  // 선택이 줄 중간에서 시작/끝나도 그 줄 전체에 적용해야 한다.
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  // 선택의 끝이 줄 시작(개행 바로 다음)이고 비어있지 않은 선택이면, 그 개행은 다음 줄
  // 소속이라 마지막 줄을 포함하지 않는다(end 를 직전 개행 위치로 당김). 빈 선택(caret)은
  // 그 자리 줄만 대상이므로 당기지 않는다.
  const effectiveEnd = end > start && text[end - 1] === '\n' ? end - 1 : end;
  const nlAfter = text.indexOf('\n', effectiveEnd);
  // 선택이 줄 경계(개행)에서 끝나면 그 개행은 다음 줄 소속이므로 포함하지 않는다.
  const lineEnd = nlAfter === -1 ? text.length : nlAfter;
  const block = text.slice(lineStart, lineEnd);
  const quoted = block
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  const newText = text.slice(0, lineStart) + quoted + text.slice(lineEnd);
  return { text: newText, newStart: lineStart, newEnd: lineStart + quoted.length };
}

/**
 * S83c (FR-KS-10): 인라인 포맷 툴바 전용 link(`[선택](url)`). 선택 텍스트를 `[ ]` 로 감싸고
 * 뒤에 `(url)` 플레이스홀더를 붙인다. 파서의 MD_LINK_RE(`^\[([^\]\n]*)\]\(([^()\s]+)\)`)와
 * 정합한다(label 은 개행 불가·url 은 공백/괄호 불가). url 자리는 사용자가 바로 입력하도록
 * `url` 리터럴을 두고, selection 을 그 `url` 위에 올려(덮어쓰기 편하게) 돌려준다 — 선택이
 * 없으면 `[](url)` 의 `url` 을 선택한다. 라벨이 비어도 파서는 [link, text=null] 로 받는다.
 */
export const LINK_URL_PLACEHOLDER = 'url';

export function wrapLink(args: { text: string; start: number; end: number }): WrapSelectionResult {
  const { text } = args;
  const { start, end } = normalizeRange(text, args.start, args.end);
  const selected = text.slice(start, end);
  const before = `[${selected}](`;
  const after = ')';
  const inserted = `${before}${LINK_URL_PLACEHOLDER}${after}`;
  const newText = text.slice(0, start) + inserted + text.slice(end);
  // selection 을 `url` 플레이스홀더 위에 올린다 — 사용자가 곧바로 URL 을 입력(덮어쓰기)한다.
  const newStart = start + before.length;
  const newEnd = newStart + LINK_URL_PLACEHOLDER.length;
  return { text: newText, newStart, newEnd };
}

/**
 * S83c (FR-KS-10): 인라인 포맷 툴바의 버튼 종류. 기존 FormatShortcut(인라인/코드블록 마커
 * 재사용) + quote(줄 prefix) + link(앵커 삽입)를 합친다. 툴바는 이 키로 MessageComposer 의
 * applyToolbarFormat 을 호출하고, composer 가 각 종류에 맞는 헬퍼(wrapSelectionPerLine /
 * prefixQuote / wrapLink)로 분기한다.
 */
export type ToolbarFormat = FormatShortcut | 'quote' | 'link';

/**
 * S83c (FR-KS-10): 인라인 포맷 툴바 표시 여부 판정(순수 함수). 선택이 비어있지 않고
 * (start !== end), 자동완성/멘션/슬래시 팝업이 닫혀 있을 때만 띄운다(겹침 방지). composer 의
 * showFormatToolbar 분기를 단위 테스트 가능하게 추출한 것이다.
 */
export function shouldShowFormatToolbar(args: {
  selectionStart: number | null;
  selectionEnd: number | null;
  autocompleteOpen: boolean;
}): boolean {
  const { selectionStart, selectionEnd, autocompleteOpen } = args;
  if (autocompleteOpen) return false;
  if (selectionStart === null || selectionEnd === null) return false;
  return selectionStart !== selectionEnd;
}

/**
 * S83c (FR-KS-10): ToolbarFormat 을 적용 결과로 변환(순수 함수). quote/link 는 전용 헬퍼,
 * 그 외(bold/italic/strike/code/codeBlock)는 마커 래핑이다. codeBlock 은 여는 펜스를 줄
 * 시작에 두기 위해 직전 문자가 개행이 아니면 `\n` 을 선행한다(applyFormat 과 동일 규칙).
 * 인라인 마커는 멀티라인이면 줄 단위로 감싼다(wrapSelectionPerLine).
 */
export function applyToolbarFormatToText(args: {
  text: string;
  start: number;
  end: number;
  format: ToolbarFormat;
}): WrapSelectionResult {
  const { text, start, end, format } = args;
  if (format === 'quote') return prefixQuote({ text, start, end });
  if (format === 'link') return wrapLink({ text, start, end });
  if (format === 'codeBlock') {
    const { start: s } = normalizeRange(text, start, end);
    const needsLeadingNewline = s > 0 && text[s - 1] !== '\n';
    const before = needsLeadingNewline
      ? `\n${FORMAT_MARKERS.codeBlock.before}`
      : FORMAT_MARKERS.codeBlock.before;
    return wrapSelection({ text, start, end, before, after: FORMAT_MARKERS.codeBlock.after });
  }
  const { before, after } = FORMAT_MARKERS[format];
  return wrapSelectionPerLine({ text, start, end, before, after });
}
