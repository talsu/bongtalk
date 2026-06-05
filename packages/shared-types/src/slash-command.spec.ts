import { describe, expect, it } from 'vitest';
import {
  CreateCustomCommandRequestSchema,
  CustomActionParamsSchema,
  CustomActionTypeSchema,
  HandlerTypeSchema,
  ResponseTypeSchema,
  SlashCommandItemSchema,
  SlashCommandListResponseSchema,
  UpdateCustomCommandRequestSchema,
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

// ── S81c (D15 / FR-SC-09·10) — 커스텀 CRUD + configurable action 계약 ─────────────
describe('CustomActionType + actionParams contract (S81c)', () => {
  it('CustomActionType 은 안전 액션 3종만 허용한다(외부 호출 없음)', () => {
    expect(CustomActionTypeSchema.parse('EPHEMERAL_TEXT')).toBe('EPHEMERAL_TEXT');
    expect(CustomActionTypeSchema.parse('SEND_TEMPLATE')).toBe('SEND_TEMPLATE');
    expect(CustomActionTypeSchema.parse('REDIRECT_CHANNEL')).toBe('REDIRECT_CHANNEL');
    // 외부 webhook/URL 류는 계약상 존재하지 않는다.
    expect(() => CustomActionTypeSchema.parse('INTERNAL_WEBHOOK')).toThrow();
    expect(() => CustomActionTypeSchema.parse('EXTERNAL_URL')).toThrow();
  });

  it('actionParams 는 actionType↔본문 정합을 강제한다(discriminated union)', () => {
    expect(
      CustomActionParamsSchema.parse({ actionType: 'EPHEMERAL_TEXT', text: '안내' }).actionType,
    ).toBe('EPHEMERAL_TEXT');
    expect(
      CustomActionParamsSchema.parse({ actionType: 'SEND_TEMPLATE', template: '{args}' })
        .actionType,
    ).toBe('SEND_TEMPLATE');
    expect(
      CustomActionParamsSchema.parse({
        actionType: 'REDIRECT_CHANNEL',
        channelId: '11111111-1111-1111-1111-111111111111',
      }).actionType,
    ).toBe('REDIRECT_CHANNEL');
    // EPHEMERAL_TEXT 에 template 만 주면(text 없음) 거부.
    expect(() =>
      CustomActionParamsSchema.parse({ actionType: 'EPHEMERAL_TEXT', template: 'x' }),
    ).toThrow();
    // REDIRECT_CHANNEL 의 channelId 는 uuid 여야 한다.
    expect(() =>
      CustomActionParamsSchema.parse({ actionType: 'REDIRECT_CHANNEL', channelId: 'not-uuid' }),
    ).toThrow();
  });
});

describe('Create/Update CustomCommand 요청 계약 (S81c)', () => {
  it('Create: name 정규식(소문자/숫자/_/-)·기본값을 강제한다', () => {
    const ok = CreateCustomCommandRequestSchema.parse({
      name: 'deploy-prod_1',
      action: { actionType: 'EPHEMERAL_TEXT', text: '배포' },
    });
    expect(ok.enabled).toBe(true);
    expect(ok.description).toBe('');
    expect(ok.usageHint).toBe('');
    // 대문자/공백/sigil 포함 name 은 거부(서버 normalize 전 형식 검증).
    expect(() =>
      CreateCustomCommandRequestSchema.parse({
        name: 'Deploy',
        action: { actionType: 'EPHEMERAL_TEXT', text: 'x' },
      }),
    ).toThrow();
    expect(() =>
      CreateCustomCommandRequestSchema.parse({
        name: '/deploy',
        action: { actionType: 'EPHEMERAL_TEXT', text: 'x' },
      }),
    ).toThrow();
    // description 255·usageHint 128 상한.
    expect(() =>
      CreateCustomCommandRequestSchema.parse({
        name: 'x',
        description: 'a'.repeat(256),
        action: { actionType: 'EPHEMERAL_TEXT', text: 'x' },
      }),
    ).toThrow();
  });

  it('Update: 부분 갱신 — 최소 1개 필드를 요구한다(빈 PATCH 거부)', () => {
    expect(UpdateCustomCommandRequestSchema.parse({ description: '변경' }).description).toBe(
      '변경',
    );
    expect(() => UpdateCustomCommandRequestSchema.parse({})).toThrow();
  });
});
