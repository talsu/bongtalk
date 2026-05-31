import { describe, it, expect } from 'vitest';
import { normalizeMentions, USERNAME_MENTION_RE } from './mention-normalizer';

describe('USERNAME_MENTION_RE', () => {
  it('matches a bare @username not preceded by a word char', () => {
    const matches = [...'hi @alice and @bob_2'.matchAll(USERNAME_MENTION_RE)].map((m) => m[1]);
    expect(matches).toEqual(['alice', 'bob_2']);
  });

  it('does NOT match an email-like local part (@ preceded by word char)', () => {
    const matches = [...'mail me at foo@example'.matchAll(USERNAME_MENTION_RE)].map((m) => m[1]);
    expect(matches).toEqual([]);
  });

  it('does NOT match an already-normalized @{cuid2} token', () => {
    const raw = 'see @{clh3z2k0v0000abcdefghijkl}';
    const matches = [...raw.matchAll(USERNAME_MENTION_RE)].map((m) => m[1]);
    // the `{` immediately after @ is not a username char → no username match
    expect(matches).toEqual([]);
  });

  it('skips @everyone / @here / @channel special mentions', () => {
    const matches = [...'@everyone @here @channel @alice'.matchAll(USERNAME_MENTION_RE)].map(
      (m) => m[1],
    );
    expect(matches).toContain('alice');
  });
});

describe('normalizeMentions (FR-MSG-13)', () => {
  const resolve = (handle: string): string | null => {
    const table: Record<string, string> = {
      alice: 'clh3z2k0v0000aaaaaaaaaaaa',
      bob: 'clh3z2k0v0000bbbbbbbbbbbb',
    };
    return table[handle.toLowerCase()] ?? null;
  };

  it('rewrites a known @username to @{cuid2}', () => {
    expect(normalizeMentions('hi @alice!', resolve)).toBe('hi @{clh3z2k0v0000aaaaaaaaaaaa}!');
  });

  it('rewrites multiple mentions', () => {
    expect(normalizeMentions('@alice @bob', resolve)).toBe(
      '@{clh3z2k0v0000aaaaaaaaaaaa} @{clh3z2k0v0000bbbbbbbbbbbb}',
    );
  });

  it('leaves unknown handles as literal text', () => {
    expect(normalizeMentions('@stranger hi', resolve)).toBe('@stranger hi');
  });

  it('does not touch @everyone / @here / @channel', () => {
    expect(normalizeMentions('@everyone @here @channel', resolve)).toBe('@everyone @here @channel');
  });

  it('does not re-normalize an already-normalized @{cuid2} token', () => {
    const raw = '@{clh3z2k0v0000aaaaaaaaaaaa}';
    expect(normalizeMentions(raw, resolve)).toBe(raw);
  });

  it('does not rewrite inside code fences (mention is literal there)', () => {
    const raw = '```\n@alice\n```';
    expect(normalizeMentions(raw, resolve)).toBe(raw);
  });

  it('does not rewrite inside inline code', () => {
    const raw = 'run `@alice` now';
    expect(normalizeMentions(raw, resolve)).toBe(raw);
  });

  it('preserves an email address (no leading-boundary mention match)', () => {
    expect(normalizeMentions('contact alice@example.com', resolve)).toBe(
      'contact alice@example.com',
    );
  });

  it('is idempotent — normalizing twice yields the same output', () => {
    const once = normalizeMentions('@alice and @bob', resolve);
    expect(normalizeMentions(once, resolve)).toBe(once);
  });
});
