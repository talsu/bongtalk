import { describe, expect, it } from 'vitest';
import {
  HandlerTypeSchema,
  ResponseTypeSchema,
  SlashCommandItemSchema,
  SlashCommandListResponseSchema,
} from './slash-command';

/**
 * S79 (D15 / FR-SC-01·02·03) — 슬래시 커맨드 계약 단위 테스트.
 */
describe('SlashCommand contract', () => {
  it('ResponseType 는 EPHEMERAL / IN_CHANNEL 만 허용한다', () => {
    expect(ResponseTypeSchema.parse('EPHEMERAL')).toBe('EPHEMERAL');
    expect(ResponseTypeSchema.parse('IN_CHANNEL')).toBe('IN_CHANNEL');
    expect(() => ResponseTypeSchema.parse('PRIVATE')).toThrow();
  });

  it('HandlerType 은 BUILTIN / INTERNAL_ACTION 만 허용한다', () => {
    expect(HandlerTypeSchema.parse('BUILTIN')).toBe('BUILTIN');
    expect(HandlerTypeSchema.parse('INTERNAL_ACTION')).toBe('INTERNAL_ACTION');
    expect(() => HandlerTypeSchema.parse('WEBHOOK')).toThrow();
  });

  it('SlashCommandItem 은 빌트인 항목을 파싱한다', () => {
    const parsed = SlashCommandItemSchema.parse({
      id: 'builtin:shrug',
      name: 'shrug',
      description: '¯\\_(ツ)_/¯ 를 덧붙입니다',
      usageHint: '/shrug [메시지]',
      responseType: 'IN_CHANNEL',
      handlerType: 'BUILTIN',
      isBuiltin: true,
    });
    expect(parsed.name).toBe('shrug');
    expect(parsed.isBuiltin).toBe(true);
  });

  it('SlashCommandItem 은 커스텀 항목(uuid·isBuiltin=false)을 파싱한다', () => {
    const parsed = SlashCommandItemSchema.parse({
      id: '11111111-1111-1111-1111-111111111111',
      name: 'deploy',
      description: '배포 트리거',
      usageHint: '/deploy [env]',
      responseType: 'EPHEMERAL',
      handlerType: 'INTERNAL_ACTION',
      isBuiltin: false,
    });
    expect(parsed.isBuiltin).toBe(false);
  });

  it('name 은 빈 문자열을 거부하고 32자 상한을 강제한다', () => {
    const base = {
      id: 'builtin:x',
      description: '',
      usageHint: '',
      responseType: 'EPHEMERAL' as const,
      handlerType: 'BUILTIN' as const,
      isBuiltin: true,
    };
    expect(() => SlashCommandItemSchema.parse({ ...base, name: '' })).toThrow();
    expect(() => SlashCommandItemSchema.parse({ ...base, name: 'a'.repeat(33) })).toThrow();
  });

  it('SlashCommandListResponse 는 items 배열을 감싼다', () => {
    const parsed = SlashCommandListResponseSchema.parse({
      items: [
        {
          id: 'builtin:me',
          name: 'me',
          description: '액션 형식',
          usageHint: '/me [메시지]',
          responseType: 'IN_CHANNEL',
          handlerType: 'BUILTIN',
          isBuiltin: true,
        },
      ],
    });
    expect(parsed.items).toHaveLength(1);
  });
});
