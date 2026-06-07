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

// S88a review F3 — normalizeMentions 의 역할 패스(@<RoleName> → <@&roleId>) longest-
// match·코드영역 회귀. 추출/정규화가 공유하는 scanRoleMentions 의 시맨틱을 정규화
// 출력 형태로 가드한다(scanner 자체는 role-mention-scanner.spec, 추출은
// mention-extractor.spec 에서 별도 커버).
describe('normalizeMentions role pass (S88a FR-MN-03 / F3)', () => {
  const resolve = (handle: string): string | null => {
    const table: Record<string, string> = { alice: 'clh3z2k0v0000aaaaaaaaaaaa' };
    return table[handle.toLowerCase()] ?? null;
  };
  const PM = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
  const PM_LEADS = '11111111-2222-3333-4444-555555555555';

  it('longest-match: rewrites only the long role, not the short prefix (uuid roleIds)', () => {
    // 핵심 회귀: "@PM Leads" 는 PM Leads 토큰으로만 치환되고 "PM" 으로 갉아먹히지 않는다.
    const out = normalizeMentions('@PM Leads go', resolve, [
      { name: 'PM', roleId: PM },
      { name: 'PM Leads', roleId: PM_LEADS },
    ]);
    expect(out).toBe(`<@&${PM_LEADS}> go`);
  });

  it('runs role pass before user pass (multi-word role not eaten by @username)', () => {
    const out = normalizeMentions('@PM Leads and @alice', resolve, [
      { name: 'PM Leads', roleId: PM_LEADS },
    ]);
    expect(out).toBe(`<@&${PM_LEADS}> and @{clh3z2k0v0000aaaaaaaaaaaa}`);
  });
});
