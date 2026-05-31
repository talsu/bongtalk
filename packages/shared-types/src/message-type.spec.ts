import { describe, it, expect } from 'vitest';
import {
  MESSAGE_TYPES,
  MessageTypeSchema,
  SYSTEM_MESSAGE_TYPES,
  SYSTEM_MESSAGE_TEMPLATES,
  isSystemMessageType,
  renderSystemMessageTemplate,
} from './message-type';

describe('MessageType enum (ADR-2 / FR-MSG-19)', () => {
  it('defines the canonical ADR-2 value set exactly', () => {
    expect([...MESSAGE_TYPES]).toEqual([
      'DEFAULT',
      'SYSTEM_MEMBER_JOINED',
      'SYSTEM_MEMBER_LEFT',
      'SYSTEM_MEMBER_BANNED',
      'SYSTEM_PIN',
      'SYSTEM_CHANNEL_RENAME',
      'SYSTEM_CHANNEL_TOPIC_CHANGED',
      'SYSTEM_CHANNEL_ARCHIVED',
      'SYSTEM_THREAD_BROADCAST',
    ]);
  });

  it('rejects deprecated D16 names (USER_JOIN etc.)', () => {
    expect(MessageTypeSchema.safeParse('USER_JOIN').success).toBe(false);
    expect(MessageTypeSchema.safeParse('CHANNEL_NAME_CHANGE').success).toBe(false);
    expect(MessageTypeSchema.safeParse('BOT_MESSAGE').success).toBe(false);
  });

  it('accepts every canonical value', () => {
    for (const t of MESSAGE_TYPES) {
      expect(MessageTypeSchema.safeParse(t).success).toBe(true);
    }
  });

  it('SYSTEM_MESSAGE_TYPES excludes DEFAULT and lists all 8 system types', () => {
    expect(SYSTEM_MESSAGE_TYPES).not.toContain('DEFAULT');
    expect(SYSTEM_MESSAGE_TYPES).toHaveLength(8);
  });
});

describe('isSystemMessageType', () => {
  it('returns true for every SYSTEM_* type', () => {
    for (const t of SYSTEM_MESSAGE_TYPES) {
      expect(isSystemMessageType(t)).toBe(true);
    }
  });

  it('returns false for DEFAULT and nullish', () => {
    expect(isSystemMessageType('DEFAULT')).toBe(false);
    expect(isSystemMessageType(null)).toBe(false);
    expect(isSystemMessageType(undefined)).toBe(false);
  });
});

describe('renderSystemMessageTemplate (FR-MSG-19 contentRaw templates)', () => {
  it('renders SYSTEM_MEMBER_JOINED with the username', () => {
    expect(renderSystemMessageTemplate('SYSTEM_MEMBER_JOINED', { username: 'alice' })).toBe(
      'alice이(가) 서버에 참가했습니다.',
    );
  });

  it('renders SYSTEM_MEMBER_BANNED', () => {
    expect(renderSystemMessageTemplate('SYSTEM_MEMBER_BANNED', { username: 'bob' })).toBe(
      'bob이(가) 추방되었습니다.',
    );
  });

  it('renders SYSTEM_CHANNEL_RENAME with old/new', () => {
    expect(
      renderSystemMessageTemplate('SYSTEM_CHANNEL_RENAME', {
        username: 'mod',
        old: 'general',
        new: 'lounge',
      }),
    ).toBe('mod이(가) 채널 이름을 general에서 lounge로 변경했습니다.');
  });

  it('renders SYSTEM_CHANNEL_TOPIC_CHANGED with quoted topic', () => {
    expect(
      renderSystemMessageTemplate('SYSTEM_CHANNEL_TOPIC_CHANGED', {
        username: 'mod',
        topic: '공지사항',
      }),
    ).toBe('mod이(가) 채널 토픽을 "공지사항"으로 변경했습니다.');
  });

  it('drops unfilled tokens to empty string (forward-compat)', () => {
    // missing `old`/`new` → tokens removed, no literal {old} leak
    const out = renderSystemMessageTemplate('SYSTEM_CHANNEL_RENAME', { username: 'mod' });
    expect(out).not.toContain('{');
    expect(out).toContain('mod이(가)');
  });

  it('every system type has a template', () => {
    for (const t of SYSTEM_MESSAGE_TYPES) {
      expect(SYSTEM_MESSAGE_TEMPLATES[t]).toBeTruthy();
    }
  });
});
