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

export function wrapSelection(args: WrapSelectionArgs): WrapSelectionResult {
  const { text, before, after } = args;
  // 경계 방어: start/end 를 [0, len] 으로 클램프하고 start <= end 보장.
  const len = text.length;
  const rawStart = Number.isFinite(args.start) ? args.start : 0;
  const rawEnd = Number.isFinite(args.end) ? args.end : 0;
  const start = Math.max(0, Math.min(len, Math.min(rawStart, rawEnd)));
  const end = Math.max(0, Math.min(len, Math.max(rawStart, rawEnd)));

  const selected = text.slice(start, end);
  const newText = text.slice(0, start) + before + selected + after + text.slice(end);
  // selection 은 원래 내용(selected) 위에 유지하되 before 길이만큼 뒤로 민다. 빈 선택이면
  // newStart === newEnd 라 커서가 before 와 after 사이에 위치한다.
  const newStart = start + before.length;
  const newEnd = end + before.length;
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
