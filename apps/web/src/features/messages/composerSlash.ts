import type { AutocompleteRow } from './autocomplete/useAutocomplete';
import { insertToken } from './autocomplete/insertToken';

/**
 * S79 (D15 / FR-SC-03) — MessageComposer 슬래시 선택 삽입 로직 (순수 함수).
 *
 * MessageComposer 의 자동완성 행 선택 경로에서 쓰는 순수 헬퍼를 분리해 DOM 마운트
 * 없이 단위 테스트할 수 있게 한다. 본 슬라이스는 자동완성 + `/명령 ` 삽입까지만
 * 다루므로(실행은 S80), 여기 로직도 "토큰 삽입 + 파라미터 힌트" 까지만이다.
 */

/** 슬래시 행 선택 시 삽입할 토큰(`/name`). insertToken 이 뒤에 공백을 덧붙인다. */
export function slashToken(commandName: string): string {
  return `/${commandName}`;
}

/**
 * 슬래시 커맨드를 트리거 범위 [start, end) 에 삽입한 결과(텍스트 + 새 캐럿).
 * insertToken 을 재사용해 `/name ` (공백 포함) 형태로 치환하고 후속 파라미터 입력을
 * 이어가게 한다. FR-SC-03 의 "선택 → /커맨드명 자동삽입(공백 포함)".
 */
export function insertSlashCommand(args: {
  text: string;
  start: number;
  end: number;
  commandName: string;
}): { text: string; caret: number } {
  return insertToken({
    text: args.text,
    start: args.start,
    end: args.end,
    token: slashToken(args.commandName),
  });
}

/**
 * Fork A = Option 1: 선택된 행이 슬래시 커맨드면 파라미터 usage hint(placeholder 일시
 * 교체용)를 돌려준다. 슬래시가 아니거나 hint 가 비면 null(기본 placeholder 유지).
 */
export function paramHintForRow(row: AutocompleteRow): string | null {
  if (row.type !== 'slash') return null;
  return row.command.usageHint || null;
}
