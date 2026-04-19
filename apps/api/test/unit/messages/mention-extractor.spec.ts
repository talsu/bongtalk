import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  extractMentions,
  normalizeContent,
} from '../../../src/messages/mentions/mention-extractor';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

type FakePrisma = {
  user: { findMany: ReturnType<typeof vi.fn> };
  channel: { findMany: ReturnType<typeof vi.fn> };
};
function makePrisma(userRows: { id: string }[], channelRows: { id: string }[]): FakePrisma {
  return {
    user: { findMany: vi.fn().mockResolvedValue(userRows) },
    channel: { findMany: vi.fn().mockResolvedValue(channelRows) },
  };
}

describe('extractMentions', () => {
  const WS = '00000000-0000-4000-8000-00000000aaaa';

  it('parses @username tokens, dedupes, scopes to workspace members', async () => {
    const fake = makePrisma([{ id: 'u1' }, { id: 'u2' }], []);
    const out = await extractMentions(fake as any, WS, 'hi @alice and @bob and @alice again');
    expect(out.users.sort()).toEqual(['u1', 'u2']);
    expect(out.everyone).toBe(false);
    const call = fake.user.findMany.mock.calls[0][0];
    expect(call.where.memberships.some.workspaceId).toBe(WS);
    expect(new Set(call.where.username.in)).toEqual(new Set(['alice', 'bob']));
  });

  it('parses #channel tokens (lowercase, dash allowed)', async () => {
    const fake = makePrisma([], [{ id: 'c1' }]);
    const out = await extractMentions(fake as any, WS, 'see #general and #not-a-channel!');
    expect(out.channels).toEqual(['c1']);
    const call = fake.channel.findMany.mock.calls[0][0];
    expect(new Set(call.where.name.in)).toEqual(new Set(['general', 'not-a-channel']));
  });

  it('detects @everyone as a separate flag (not a username)', async () => {
    const fake = makePrisma([], []);
    const out = await extractMentions(fake as any, WS, 'ping @everyone!');
    expect(out.everyone).toBe(true);
    expect(out.users).toEqual([]);
    expect(fake.user.findMany).not.toHaveBeenCalled();
  });

  it('ignores tokens embedded in words (email-like, code-like)', async () => {
    const fake = makePrisma([], []);
    await extractMentions(fake as any, WS, 'mail me@example.com or look#1');
    expect(fake.user.findMany).not.toHaveBeenCalled();
    expect(fake.channel.findMany).not.toHaveBeenCalled();
  });

  it('drops unknown handles (not in workspace) silently', async () => {
    const fake = makePrisma([], []); // no matching users
    const out = await extractMentions(fake as any, WS, '@ghost hello');
    expect(out.users).toEqual([]);
  });

  it('mixes user, channel, and everyone in one message', async () => {
    const fake = makePrisma([{ id: 'u1' }], [{ id: 'c1' }]);
    const out = await extractMentions(fake as any, WS, '@alice ping #general @everyone');
    expect(out).toEqual({ users: ['u1'], channels: ['c1'], everyone: true });
  });
});

describe('normalizeContent', () => {
  it('strips mention sigils and collapses whitespace', () => {
    expect(normalizeContent('Hey @alice,   look at   #general!')).toBe(
      'Hey alice, look at general!',
    );
  });

  it('leaves non-mention content alone', () => {
    expect(normalizeContent('plain text — no hashes')).toBe('plain text — no hashes');
  });
});
