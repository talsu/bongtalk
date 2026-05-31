/**
 * S18 (FR-RC06) — 선택 항목을 트리거 범위에 삽입 (순수 함수).
 *
 * detectTrigger 가 돌려준 [start, end) 구간(sigil ~ 캐럿)을 선택 토큰으로
 * 치환하고, 뒤에 공백 하나를 붙여 후속 입력을 이어가기 쉽게 합니다. 다음
 * 문자가 이미 공백이면 중복 공백을 넣지 않습니다. 새 캐럿 위치를 함께
 * 반환해 호출부가 textarea selectionRange 를 복원합니다.
 */
type InsertInput = {
  text: string;
  start: number;
  end: number;
  /** 삽입할 토큰(@alice / #general / 🎉 / :name: 등). */
  token: string;
};

export type InsertResult = {
  text: string;
  caret: number;
};

export function insertToken({ text, start, end, token }: InsertInput): InsertResult {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const needsSpace = after.length === 0 || after[0] !== ' ';
  const insertion = needsSpace ? `${token} ` : token;
  const nextText = before + insertion + after;
  const caret = before.length + insertion.length;
  return { text: nextText, caret };
}
