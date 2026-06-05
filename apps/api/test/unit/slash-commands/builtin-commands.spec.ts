import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SlashCommandItemSchema } from '@qufox/shared-types';
import {
  BUILTIN_COMMAND_NAMES,
  buildBuiltinCommands,
} from '../../../src/slash-commands/builtin-commands';

/**
 * S79 (D15 / FR-SC-01) — BUILTIN_COMMANDS 상수 단위 테스트.
 */
describe('BUILTIN_COMMANDS', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('PRD D15 의 의미있는 빌트인 커맨드를 포함한다', () => {
    const names = new Set(BUILTIN_COMMAND_NAMES);
    for (const expected of ['shrug', 'me', 'status', 'dnd', 'remind', 'giphy']) {
      expect(names.has(expected)).toBe(true);
    }
    // 충분한 규모(≥ 10) 인지 확인.
    expect(BUILTIN_COMMAND_NAMES.length).toBeGreaterThanOrEqual(10);
  });

  it('giphyEnabled=false 면 /giphy 를 제외한다', () => {
    const list = buildBuiltinCommands(false);
    expect(list.some((c) => c.name === 'giphy')).toBe(false);
    expect(list.some((c) => c.name === 'shrug')).toBe(true);
  });

  it('giphyEnabled=true 면 /giphy 를 포함한다', () => {
    const list = buildBuiltinCommands(true);
    expect(list.some((c) => c.name === 'giphy')).toBe(true);
  });

  it('모든 빌트인 항목은 SlashCommandItem 계약을 만족하고 isBuiltin=true·id=builtin:<name>', () => {
    for (const cmd of buildBuiltinCommands(true)) {
      expect(() => SlashCommandItemSchema.parse(cmd)).not.toThrow();
      expect(cmd.isBuiltin).toBe(true);
      expect(cmd.id).toBe(`builtin:${cmd.name}`);
    }
  });

  it('빌트인 커맨드명은 중복이 없다', () => {
    const names = buildBuiltinCommands(true).map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
