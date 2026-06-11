import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  MENTION_USER_RE,
  mentionUserRe,
  MENTION_CHANNEL_RE,
  MENTION_ROLE_RE,
  EMOJI_RE,
  extractMentionUserIds,
  MRKDWN_PARSE_LIMITS,
  MRKDWN_PARSE_ERROR_CODES,
  MRKDWN_AST_NODE_TYPES,
  CUID2_RE,
  Cuid2Schema,
} from './mrkdwn';
import { ErrorCodeSchema } from './index';
import { EmojiNodeSchema } from './mrkdwn-ast';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('MENTION_USER_RE (FR-RC22)', () => {
  it('has the canonical source and global flag', () => {
    // 071-M1 D11 (FR-RC22): uuid|cuid2 transitional — User.id 가 @db.Uuid 라
    // uuid 분기가 선두에 온다(S88a MENTION_ROLE_RE 와 동일 구조).
    expect(MENTION_USER_RE.source).toBe(
      '@\\{([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9]{20,})\\}',
    );
    expect(MENTION_USER_RE.flags).toBe('g');
  });

  it('captures a 20+ char cuid2 token', () => {
    const re = mentionUserRe();
    const m = re.exec('hi @{clh3z2k0v0000abcd1234ef} there');
    expect(m?.[1]).toBe('clh3z2k0v0000abcd1234ef');
  });

  it('rejects tokens shorter than 20 chars', () => {
    expect(mentionUserRe().test('@{short123}')).toBe(false);
  });

  it('rejects uppercase / punctuation inside the token', () => {
    expect(mentionUserRe().test('@{ABCDEFGHIJKLMNOPQRSTUV}')).toBe(false);
    expect(mentionUserRe().test('@{abc-def-ghi-jkl-mno-pqr}')).toBe(false);
  });

  it('extractMentionUserIds returns every distinct token in order', () => {
    const ids = extractMentionUserIds('@{aaaaaaaaaaaaaaaaaaaa} x @{bbbbbbbbbbbbbbbbbbbb}');
    expect(ids).toEqual(['aaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbb']);
  });

  it('mentionUserRe() factory has independent lastIndex', () => {
    const a = mentionUserRe();
    a.exec('@{aaaaaaaaaaaaaaaaaaaa}');
    expect(a.lastIndex).toBeGreaterThan(0);
    // a fresh factory instance is reset
    expect(mentionUserRe().lastIndex).toBe(0);
  });
});

describe('Cuid2Schema (ADR-1 mention id alignment)', () => {
  it('accepts the token captured by MENTION_USER_RE', () => {
    const token = extractMentionUserIds('@{clh3z2k0v0000abcd1234ef}')[0];
    expect(() => Cuid2Schema.parse(token)).not.toThrow();
  });

  it('rejects a uuid (cuid2-only)', () => {
    expect(() => Cuid2Schema.parse('00000000-0000-0000-0000-000000000000')).toThrow();
  });

  it('rejects sub-20-char / uppercase ids', () => {
    expect(() => Cuid2Schema.parse('short123')).toThrow();
    expect(() => Cuid2Schema.parse('ABCDEFGHIJKLMNOPQRSTUV')).toThrow();
  });

  it('CUID2_RE is anchored', () => {
    expect(CUID2_RE.source).toBe('^[a-z0-9]{20,}$');
  });
});

describe('channel / role / emoji regexes', () => {
  it('MENTION_CHANNEL_RE matches <#cuid2>', () => {
    expect(new RegExp(MENTION_CHANNEL_RE.source).exec('<#clh3z2k0v0000abcd1234>')?.[1]).toBe(
      'clh3z2k0v0000abcd1234',
    );
  });

  it('MENTION_ROLE_RE matches <@&cuid2>', () => {
    expect(new RegExp(MENTION_ROLE_RE.source).exec('<@&clh3z2k0v0000abcd1234>')?.[1]).toBe(
      'clh3z2k0v0000abcd1234',
    );
  });

  // S88a (FR-MN-03 / FR-RC22): Role.id 는 @db.Uuid 라 토큰이 uuid 여야 한다.
  it('MENTION_ROLE_RE matches <@&uuid> (Role.id = @db.Uuid)', () => {
    expect(
      new RegExp(MENTION_ROLE_RE.source).exec('<@&3f2504e0-4f89-41d3-9a0c-0305e82c3301>')?.[1],
    ).toBe('3f2504e0-4f89-41d3-9a0c-0305e82c3301');
  });

  it('MENTION_ROLE_RE matches multiple role tokens (uuid + cuid2 mixed)', () => {
    const text = 'hey <@&3f2504e0-4f89-41d3-9a0c-0305e82c3301> and <@&clh3z2k0v0000abcd1234>';
    const ids = [...text.matchAll(new RegExp(MENTION_ROLE_RE.source, 'g'))].map((m) => m[1]);
    expect(ids).toEqual(['3f2504e0-4f89-41d3-9a0c-0305e82c3301', 'clh3z2k0v0000abcd1234']);
  });

  // 071-M1 D11 (FR-RC22): User.id / Channel.id 도 @db.Uuid — S88a 가 역할만
  // 확장하고 남겨둔 잠복 버그(라이브 유저/채널 멘션 토큰이 영영 미매칭 →
  // 멘션 pill 평문 깨짐). 세 토큰 전부 uuid|cuid2 를 수용해야 한다.
  it('MENTION_USER_RE matches @{uuid} (User.id = @db.Uuid)', () => {
    expect(
      new RegExp(MENTION_USER_RE.source).exec('@{3f2504e0-4f89-41d3-9a0c-0305e82c3301}')?.[1],
    ).toBe('3f2504e0-4f89-41d3-9a0c-0305e82c3301');
  });

  it('MENTION_CHANNEL_RE matches <#uuid> (Channel.id = @db.Uuid)', () => {
    expect(
      new RegExp(MENTION_CHANNEL_RE.source).exec('<#3f2504e0-4f89-41d3-9a0c-0305e82c3301>')?.[1],
    ).toBe('3f2504e0-4f89-41d3-9a0c-0305e82c3301');
  });

  // 071-M3 F10: emoji customId 도 uuid 수용(CustomEmoji.id = @db.Uuid).
  it('EmojiNodeSchema accepts a uuid customId', () => {
    expect(() =>
      EmojiNodeSchema.parse({
        type: 'emoji',
        name: 'party',
        customId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      }),
    ).not.toThrow();
  });

  it('MENTION_USER_RE still rejects malformed uuid-ish garbage (hyphen positions enforced)', () => {
    expect(
      new RegExp(MENTION_USER_RE.source).exec('@{------------------------------------}'),
    ).toBeNull();
  });

  // S88a review F5 (security): uuid 분기는 RFC-4122 8-4-4-4-12 고정 구조여야
  // 한다. 종전 `[0-9a-f-]{36}` 은 하이픈 36개 같은 garbage 도 수락했다.
  it('MENTION_ROLE_RE rejects garbage uuid-shaped tokens (36 hyphens / wrong layout)', () => {
    const allHyphens = `<@&${'-'.repeat(36)}>`;
    expect(new RegExp(MENTION_ROLE_RE.source).test(allHyphens)).toBe(false);
    // 자리수 위치가 어긋난 36자(하이픈 위치 불일치)도 거부.
    const wrongLayout = '<@&3f2504e04f8941d39a0c0305e82c33-1>';
    expect(new RegExp(MENTION_ROLE_RE.source).test(wrongLayout)).toBe(false);
  });

  it('EMOJI_RE matches :name: within 2-32 lowercase/underscore', () => {
    expect(new RegExp(EMOJI_RE.source).exec(':party_blob:')?.[1]).toBe('party_blob');
    expect(new RegExp(EMOJI_RE.source).test(':a:')).toBe(false); // too short (min 2)
    expect(new RegExp(EMOJI_RE.source).test(':Upper:')).toBe(false);
  });
});

describe('MRKDWN_PARSE_LIMITS (FR-MSG-23)', () => {
  it('matches the canonical ReDoS guard values', () => {
    expect(MRKDWN_PARSE_LIMITS.TIMEOUT_MS).toBe(50);
    expect(MRKDWN_PARSE_LIMITS.MAX_DEPTH).toBe(10);
    expect(MRKDWN_PARSE_LIMITS.MAX_NODES).toBe(500);
    expect(MRKDWN_PARSE_LIMITS.MAX_AST_BYTES).toBe(64 * 1024);
    expect(MRKDWN_PARSE_LIMITS.MAX_PLAIN_LENGTH).toBe(4000);
  });

  it('exposes the four parse error codes', () => {
    expect(MRKDWN_PARSE_ERROR_CODES).toEqual([
      'PARSE_TIMEOUT',
      'PARSE_DEPTH_EXCEEDED',
      'PARSE_NODE_LIMIT',
      'PARSE_AST_TOO_LARGE',
    ]);
  });

  it('lists the 14 AST node types from D16', () => {
    expect(MRKDWN_AST_NODE_TYPES).toContain('mention_user');
    expect(MRKDWN_AST_NODE_TYPES).toContain('code_block');
    expect(MRKDWN_AST_NODE_TYPES).toContain('divider');
    expect(MRKDWN_AST_NODE_TYPES).toHaveLength(14);
  });

  it('every parse error code is a member of the shared ErrorCode enum', () => {
    for (const code of MRKDWN_PARSE_ERROR_CODES) {
      expect(() => ErrorCodeSchema.parse(code)).not.toThrow();
    }
  });
});
