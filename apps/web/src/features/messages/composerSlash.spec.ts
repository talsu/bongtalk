import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlashCommandItem } from '@qufox/shared-types';
import type { AutocompleteRow } from './autocomplete/useAutocomplete';
import {
  detectSlashExecution,
  insertSlashCommand,
  paramHintForRow,
  slashToken,
} from './composerSlash';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

const command = (over: Partial<SlashCommandItem> & { name: string }): SlashCommandItem => ({
  id: `builtin:${over.name}`,
  description: '',
  usageHint: '',
  responseType: 'EPHEMERAL',
  handlerType: 'BUILTIN',
  isBuiltin: true,
  ...over,
});

describe('composerSlash (S79 / FR-SC-03) — 선택 삽입 + 파라미터 힌트', () => {
  it('slashToken 은 /이름 형태를 만든다', () => {
    expect(slashToken('shrug')).toBe('/shrug');
  });

  it('insertSlashCommand 는 트리거 범위를 /name 으로 치환하고 공백을 덧붙인다', () => {
    // 컴포저에 `/sh` 만 입력된 상태에서 shrug 선택.
    const r = insertSlashCommand({ text: '/sh', start: 0, end: 3, commandName: 'shrug' });
    expect(r.text).toBe('/shrug ');
    // 캐럿은 삽입된 공백 뒤(파라미터 입력 위치).
    expect(r.caret).toBe('/shrug '.length);
  });

  it('insertSlashCommand 는 뒤에 이미 공백이 있으면 중복 공백을 넣지 않는다', () => {
    const r = insertSlashCommand({ text: '/sh end', start: 0, end: 3, commandName: 'shrug' });
    expect(r.text).toBe('/shrug end');
  });

  it('paramHintForRow 는 슬래시 행의 usageHint 를 돌려준다(Fork A placeholder 교체)', () => {
    const row: AutocompleteRow = {
      type: 'slash',
      command: command({ name: 'remind', usageHint: '/remind [@사람] "할일" [시간]' }),
    };
    expect(paramHintForRow(row)).toBe('/remind [@사람] "할일" [시간]');
  });

  it('paramHintForRow 는 usageHint 가 비면 null', () => {
    const row: AutocompleteRow = { type: 'slash', command: command({ name: 'away' }) };
    expect(paramHintForRow(row)).toBeNull();
  });

  it('paramHintForRow 는 슬래시가 아닌 행이면 null(기본 placeholder 유지)', () => {
    const row: AutocompleteRow = {
      type: 'member',
      member: { userId: 'u1', username: 'alice' },
      online: true,
    };
    expect(paramHintForRow(row)).toBeNull();
  });
});

describe('detectSlashExecution (S80 / FR-SC-04·05·06)', () => {
  const commands: SlashCommandItem[] = [
    command({ name: 'shrug', responseType: 'IN_CHANNEL', handlerType: 'BUILTIN' }),
    command({ name: 'me', responseType: 'IN_CHANNEL', handlerType: 'BUILTIN' }),
    command({ name: 'remind', handlerType: 'INTERNAL_ACTION' }),
  ];

  it('알려진 커맨드 + 인자를 분리한다', () => {
    expect(detectSlashExecution('/shrug 안녕', commands)).toEqual({
      command: 'shrug',
      text: '안녕',
    });
  });

  it('인자 없는 커맨드는 text 빈 문자열', () => {
    expect(detectSlashExecution('/me', commands)).toEqual({ command: 'me', text: '' });
  });

  it('대소문자 무관하게 매칭한다', () => {
    expect(detectSlashExecution('/SHRUG x', commands)?.command).toBe('shrug');
  });

  it('목록에 없는 커맨드는 null(일반 메시지로 전송)', () => {
    expect(detectSlashExecution('/unknown x', commands)).toBeNull();
  });

  it('슬래시로 시작하지 않으면 null', () => {
    expect(detectSlashExecution('hello', commands)).toBeNull();
    expect(detectSlashExecution('text /shrug', commands)).toBeNull();
  });
});
