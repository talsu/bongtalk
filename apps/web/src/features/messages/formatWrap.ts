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
