import { describe, expect, it } from 'vitest';
import {
  CreateReminderRequestSchema,
  ExecuteSlashCommandRequestSchema,
  ExecuteSlashCommandResponseSchema,
  GiphySearchRequestSchema,
  GiphySearchResponseSchema,
  ReminderItemSchema,
  ReminderListResponseSchema,
  ReminderStatusSchema,
} from './slash-execution';
import { WS_EVENTS, WS_EVENT_PAYLOAD_SCHEMAS, ReminderNewFirePayloadSchema } from './events';

/**
 * S80 (D15 / FR-SC-04·05·06 + FR-RC18) — 슬래시 실행 + Reminder 계약 단위 테스트.
 */
describe('ExecuteSlashCommand contract', () => {
  it('요청은 command/text/idempotencyKey 를 파싱한다', () => {
    const parsed = ExecuteSlashCommandRequestSchema.parse({
      command: 'shrug',
      text: '안녕',
      idempotencyKey: '11111111-1111-1111-1111-111111111111',
    });
    expect(parsed.command).toBe('shrug');
    expect(parsed.text).toBe('안녕');
  });

  it('command 가 33자를 넘으면 거부한다', () => {
    expect(() =>
      ExecuteSlashCommandRequestSchema.parse({
        command: 'a'.repeat(34),
        text: '',
        idempotencyKey: '11111111-1111-1111-1111-111111111111',
      }),
    ).toThrow();
  });

  it('idempotencyKey 는 uuid 여야 한다', () => {
    expect(() =>
      ExecuteSlashCommandRequestSchema.parse({
        command: 'shrug',
        text: '',
        idempotencyKey: 'not-a-uuid',
      }),
    ).toThrow();
  });

  it('IN_CHANNEL 응답은 messageId 를 가진다', () => {
    const parsed = ExecuteSlashCommandResponseSchema.parse({
      responseType: 'IN_CHANNEL',
      messageId: '22222222-2222-2222-2222-222222222222',
    });
    expect(parsed.responseType).toBe('IN_CHANNEL');
    if (parsed.responseType === 'IN_CHANNEL') {
      expect(parsed.messageId).toBe('22222222-2222-2222-2222-222222222222');
    }
  });

  it('EPHEMERAL 응답은 content(+선택 error)를 가진다', () => {
    const ok = ExecuteSlashCommandResponseSchema.parse({
      responseType: 'EPHEMERAL',
      content: '상태를 자리 비움으로 바꿨습니다',
    });
    expect(ok.responseType).toBe('EPHEMERAL');
    const err = ExecuteSlashCommandResponseSchema.parse({
      responseType: 'EPHEMERAL',
      content: '시각을 이해하지 못했습니다',
      error: true,
    });
    if (err.responseType === 'EPHEMERAL') expect(err.error).toBe(true);
  });

  it('IN_CHANNEL 응답에 content 만 있으면 거부한다(discriminated union)', () => {
    expect(() =>
      ExecuteSlashCommandResponseSchema.parse({
        responseType: 'IN_CHANNEL',
        content: '잘못된 조합',
      }),
    ).toThrow();
  });

  // S81b (FR-SC-07): /giphy 실행 — GIPHY_PREVIEW 변형.
  it('GIPHY_PREVIEW 응답은 gifUrl/gifThumbUrl/title/keyword/offset 을 가진다', () => {
    const parsed = ExecuteSlashCommandResponseSchema.parse({
      responseType: 'GIPHY_PREVIEW',
      gifUrl: 'https://media.giphy.com/media/abc/giphy.gif',
      gifThumbUrl: 'https://media.giphy.com/media/abc/200w.gif',
      title: 'cat',
      keyword: 'cat',
      offset: 0,
    });
    expect(parsed.responseType).toBe('GIPHY_PREVIEW');
    if (parsed.responseType === 'GIPHY_PREVIEW') {
      expect(parsed.keyword).toBe('cat');
      expect(parsed.offset).toBe(0);
    }
  });

  it('GIPHY_PREVIEW 응답의 gifUrl 은 URL 이어야 한다', () => {
    expect(() =>
      ExecuteSlashCommandResponseSchema.parse({
        responseType: 'GIPHY_PREVIEW',
        gifUrl: 'not-a-url',
        gifThumbUrl: 'https://media.giphy.com/media/abc/200w.gif',
        title: 'cat',
        keyword: 'cat',
        offset: 0,
      }),
    ).toThrow();
  });
});

// S81b (FR-SC-07): /giphy Shuffle 재요청 계약.
describe('GiphySearch contract', () => {
  it('요청은 keyword(+선택 offset)를 파싱한다', () => {
    const parsed = GiphySearchRequestSchema.parse({ keyword: 'dog', offset: 3 });
    expect(parsed.keyword).toBe('dog');
    expect(parsed.offset).toBe(3);
  });

  it('keyword 가 비면 거부한다', () => {
    expect(() => GiphySearchRequestSchema.parse({ keyword: '' })).toThrow();
  });

  it('keyword 가 100자를 넘으면 거부한다', () => {
    expect(() => GiphySearchRequestSchema.parse({ keyword: 'a'.repeat(101) })).toThrow();
  });

  it('offset 은 음수면 거부한다', () => {
    expect(() => GiphySearchRequestSchema.parse({ keyword: 'dog', offset: -1 })).toThrow();
  });

  it('응답은 gifUrl/gifThumbUrl/title 을 파싱한다', () => {
    const parsed = GiphySearchResponseSchema.parse({
      gifUrl: 'https://media.giphy.com/media/abc/giphy.gif',
      gifThumbUrl: 'https://media.giphy.com/media/abc/200w.gif',
      title: 'dog',
    });
    expect(parsed.title).toBe('dog');
  });
});

describe('Reminder contract', () => {
  it('ReminderStatus 는 PENDING/SENT/CANCELLED 만 허용한다', () => {
    expect(ReminderStatusSchema.parse('PENDING')).toBe('PENDING');
    expect(ReminderStatusSchema.parse('SENT')).toBe('SENT');
    expect(ReminderStatusSchema.parse('CANCELLED')).toBe('CANCELLED');
    expect(() => ReminderStatusSchema.parse('DONE')).toThrow();
  });

  it('ReminderItem 을 파싱한다', () => {
    const parsed = ReminderItemSchema.parse({
      id: '33333333-3333-3333-3333-333333333333',
      channelId: '44444444-4444-4444-4444-444444444444',
      message: '회의 준비',
      scheduledAt: '2025-01-01T10:00:00.000Z',
      status: 'PENDING',
      createdAt: '2025-01-01T00:00:00.000Z',
    });
    expect(parsed.message).toBe('회의 준비');
  });

  it('ReminderItem.channelId 는 null 을 허용한다', () => {
    const parsed = ReminderItemSchema.parse({
      id: '33333333-3333-3333-3333-333333333333',
      channelId: null,
      message: '물 마시기',
      scheduledAt: '2025-01-01T10:00:00.000Z',
      status: 'SENT',
      createdAt: '2025-01-01T00:00:00.000Z',
    });
    expect(parsed.channelId).toBeNull();
  });

  it('ReminderList 응답은 items 배열을 가진다', () => {
    const parsed = ReminderListResponseSchema.parse({ items: [] });
    expect(parsed.items).toHaveLength(0);
  });

  it('CreateReminderRequest 는 when/message 를 요구한다', () => {
    const parsed = CreateReminderRequestSchema.parse({
      when: 'tomorrow 10am',
      message: '약 먹기',
      channelId: null,
    });
    expect(parsed.when).toBe('tomorrow 10am');
    expect(() => CreateReminderRequestSchema.parse({ when: '', message: '빈 시각' })).toThrow();
  });
});

describe('reminder:fire WS event', () => {
  it('WS_EVENTS 에 reminder:fire 와이어 이름이 등록돼 있다', () => {
    expect(WS_EVENTS.REMINDER_NEW_FIRE).toBe('reminder:fire');
    // S53 의 user:reminder_fire 와는 별개 와이어 이름.
    expect(WS_EVENTS.REMINDER_NEW_FIRE).not.toBe(WS_EVENTS.REMINDER_FIRE);
  });

  it('payload 스키마가 카탈로그에 매핑돼 있다', () => {
    expect(WS_EVENT_PAYLOAD_SCHEMAS[WS_EVENTS.REMINDER_NEW_FIRE]).toBeDefined();
    const parsed = ReminderNewFirePayloadSchema.parse({
      reminderId: '33333333-3333-3333-3333-333333333333',
      message: '회의 준비',
      channelId: '44444444-4444-4444-4444-444444444444',
    });
    expect(parsed.message).toBe('회의 준비');
  });
});
