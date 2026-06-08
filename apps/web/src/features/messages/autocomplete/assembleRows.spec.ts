import { describe, it, expect, beforeEach, vi } from 'vitest';
import { assembleRows, type AutocompleteSources } from './useAutocomplete';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

const baseSources = (overrides: Partial<AutocompleteSources> = {}): AutocompleteSources => ({
  members: [
    { userId: 'u1', username: 'alice' },
    { userId: 'u2', username: 'alan' },
    { userId: 'u3', username: 'bob' },
  ],
  channels: [
    { id: 'c1', name: 'general', topic: '잡담' },
    { id: 'c2', name: 'gaming', topic: null },
  ],
  customEmojis: [{ kind: 'custom', name: 'party_parrot', url: 'https://cdn/p.png' }],
  slashCommands: [],
  online: new Set<string>(['u1']),
  recentMembers: [],
  recentEmojis: [],
  role: 'MEMBER',
  ...overrides,
});

describe('assembleRows (FR-RC03/04/05) — 트리거 → 행 조립 합성', () => {
  it('returns no trigger when the caret is not on a sigil', () => {
    const r = assembleRows('hello', 5, baseSources());
    expect(r.trigger).toBeNull();
    expect(r.rows).toEqual([]);
  });

  it('@ mention rows for a MEMBER have no special items (here/everyone gated)', () => {
    const r = assembleRows('@a', 2, baseSources({ role: 'MEMBER' }));
    expect(r.trigger?.kind).toBe('mention');
    // S18 리뷰 MAJOR: MEMBER 는 @here/@everyone 모두 권한 없음 → 특수항목 없음.
    // @channel 은 어떤 역할에서도 더 이상 등장하지 않는다.
    const specials = r.rows.filter((row) => row.type === 'special');
    expect(specials).toHaveLength(0);
    // members matching prefix "a": alan, alice (online weighting → alice first).
    const memberNames = r.rows
      .filter((row) => row.type === 'member')
      .map((row) => (row.type === 'member' ? row.member.username : ''));
    expect(memberNames).toContain('alice');
    expect(memberNames).toContain('alan');
    expect(memberNames).not.toContain('bob');
  });

  // S94 (067, Option B): @channel 도 기본 MEMBER 허용이 되어 자동완성에 노출된다(복원).
  it('@ mention rows for an OWNER include @here, @channel and @everyone', () => {
    const r = assembleRows('@', 1, baseSources({ role: 'OWNER' }));
    const specialKeys = r.rows
      .filter((row) => row.type === 'special')
      .map((row) => (row.type === 'special' ? (row.item.key as string) : ''));
    expect(specialKeys).toContain('here');
    expect(specialKeys).toContain('channel');
    expect(specialKeys).toContain('everyone');
  });

  it('OWNER sees @everyone in the @ rows', () => {
    const r = assembleRows('@', 1, baseSources({ role: 'OWNER' }));
    const hasEveryone = r.rows.some((row) => row.type === 'special' && row.item.key === 'everyone');
    expect(hasEveryone).toBe(true);
  });

  it('# channel rows filter by prefix and carry topic', () => {
    const r = assembleRows('#gen', 4, baseSources());
    expect(r.trigger?.kind).toBe('channel');
    const names = r.rows.map((row) => (row.type === 'channel' ? row.channel.name : ''));
    expect(names).toEqual(['general']);
  });

  it(': emoji rows require >= 2 query chars and mix custom + unicode', () => {
    // single char → below the FR-RC05 threshold, no trigger.
    expect(assembleRows(':p', 2, baseSources()).trigger).toBeNull();
    // >= 2 chars → emoji trigger fires.
    const two = assembleRows(':pa', 3, baseSources());
    expect(two.trigger?.kind).toBe('emoji');
    expect(two.rows.length).toBeGreaterThan(0);
    const partyRow = two.rows.find(
      (row) => row.type === 'emoji' && row.emoji.name === 'party_parrot',
    );
    expect(partyRow).toBeDefined();
  });

  it('is disabled for Global DM (enabled=false → no trigger)', () => {
    const r = assembleRows('@a', 2, baseSources(), false);
    expect(r.trigger).toBeNull();
    expect(r.rows).toEqual([]);
  });
});

// S88a (FR-MN-03): @ 자동완성 역할 행 — mentionable 은 모두, non-mentionable 은
// OWNER/ADMIN 에게만 노출(보수적 클라 규칙 · 서버 최종 권위).
describe('assembleRows — role mention rows (S88a / FR-MN-03)', () => {
  const roles = [
    { id: 'r1', name: 'Engineers', colorHex: null, mentionable: true },
    { id: 'r2', name: 'Secret', colorHex: null, mentionable: false },
    { id: 'r3', name: 'Eng Leads', colorHex: '#ff0000', mentionable: true },
  ];

  it('MEMBER 는 mentionable 역할만 본다(non-mentionable 숨김)', () => {
    const r = assembleRows('@', 1, baseSources({ role: 'MEMBER', roles }));
    const roleNames = r.rows
      .filter((row) => row.type === 'role')
      .map((row) => (row.type === 'role' ? row.role.name : ''));
    expect(roleNames).toContain('Engineers');
    expect(roleNames).toContain('Eng Leads');
    expect(roleNames).not.toContain('Secret');
  });

  it('OWNER 는 non-mentionable 역할도 본다', () => {
    const r = assembleRows('@', 1, baseSources({ role: 'OWNER', roles }));
    const roleNames = r.rows
      .filter((row) => row.type === 'role')
      .map((row) => (row.type === 'role' ? row.role.name : ''));
    expect(roleNames).toContain('Secret');
  });

  it('역할명 prefix(case-insensitive)로 필터한다', () => {
    const r = assembleRows('@eng', 4, baseSources({ role: 'MEMBER', roles }));
    const roleNames = r.rows
      .filter((row) => row.type === 'role')
      .map((row) => (row.type === 'role' ? row.role.name : ''));
    expect(roleNames).toEqual(['Engineers', 'Eng Leads']);
  });

  it('roles 미주입이면 역할 행이 없다(기존 동작)', () => {
    const r = assembleRows('@', 1, baseSources({ role: 'OWNER' }));
    expect(r.rows.some((row) => row.type === 'role')).toBe(false);
  });
});
