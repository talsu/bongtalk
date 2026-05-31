import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rankMembers, type RankableMember } from './rankMembers';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

const m = (username: string): RankableMember => ({ userId: username, username });

describe('rankMembers (FR-RC03) — prefix 매치 + 온라인 가중치 + 최근성', () => {
  it('keeps only prefix matches (case-insensitive)', () => {
    const out = rankMembers({
      members: [m('alice'), m('bob'), m('Alan')],
      query: 'al',
      online: new Set(),
      recent: [],
      limit: 8,
    });
    expect(out.map((x) => x.username)).toEqual(['Alan', 'alice']);
  });

  it('returns all members (capped) for an empty query', () => {
    const out = rankMembers({
      members: [m('a'), m('b'), m('c')],
      query: '',
      online: new Set(),
      recent: [],
      limit: 8,
    });
    expect(out).toHaveLength(3);
  });

  it('caps the result at the limit (max 8)', () => {
    const members = Array.from({ length: 20 }, (_, i) => m(`user${i}`));
    const out = rankMembers({ members, query: '', online: new Set(), recent: [], limit: 8 });
    expect(out).toHaveLength(8);
  });

  it('ranks online members above offline ones at equal prefix quality', () => {
    const out = rankMembers({
      members: [m('amy'), m('ana')],
      query: 'a',
      online: new Set(['ana']),
      recent: [],
      limit: 8,
    });
    expect(out[0].username).toBe('ana');
  });

  it('ranks recent conversation partners highest', () => {
    const out = rankMembers({
      members: [m('amy'), m('ana'), m('abe')],
      query: 'a',
      online: new Set(['amy']),
      recent: ['abe'],
      limit: 8,
    });
    // abe is recent (strongest), then amy (online), then ana.
    expect(out.map((x) => x.username)).toEqual(['abe', 'amy', 'ana']);
  });

  it('breaks ties alphabetically for deterministic ordering', () => {
    const out = rankMembers({
      members: [m('charlie'), m('bravo'), m('bonus')],
      query: 'b',
      online: new Set(),
      recent: [],
      limit: 8,
    });
    expect(out.map((x) => x.username)).toEqual(['bonus', 'bravo']);
  });
});
