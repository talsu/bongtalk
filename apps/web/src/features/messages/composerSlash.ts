import type { SlashCommandItem } from '@qufox/shared-types';
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

/**
 * S80 (D15 / FR-SC-04·05·06) — draft 가 실행 가능한 슬래시 커맨드인지 감지(순수 함수).
 *
 * `/` 로 시작하고 첫 토큰이 BUILTIN/커스텀 커맨드 목록에 있으면 { command, text } 를 돌려준다.
 * 아니면 null(일반 메시지로 doSend 진행). 첫 토큰 뒤 나머지를 text(인자)로 분리한다.
 *
 * 예: `/shrug 안녕` → { command: 'shrug', text: '안녕' }
 *     `/me waves`   → { command: 'me', text: 'waves' }
 *     `/unknown x`  → null(목록에 없음 — 일반 메시지로 전송)
 *     `hello`       → null
 */
export function detectSlashExecution(
  draft: string,
  commands: SlashCommandItem[],
): { command: string; text: string } | null {
  if (!draft.startsWith('/')) return null;
  const body = draft.slice(1);
  // 첫 공백/줄바꿈 기준으로 커맨드명과 인자를 분리한다.
  const match = body.match(/^([^\s]+)([\s\S]*)$/);
  if (!match) return null;
  const command = match[1].toLowerCase();
  const text = match[2].replace(/^\s+/, '');
  const known = commands.some((c) => c.name.toLowerCase() === command);
  if (!known) return null;
  return { command, text };
}
