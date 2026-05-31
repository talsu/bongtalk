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

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('MENTION_USER_RE (FR-RC22)', () => {
  it('has the canonical source and global flag', () => {
    expect(MENTION_USER_RE.source).toBe('@\\{([a-z0-9]{20,})\\}');
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
