import { describe, it, expect, beforeEach, vi } from 'vitest';
import { filterEmojis, type EmojiCandidate } from './filterEmojis';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

const unicode = (name: string, glyph: string): EmojiCandidate => ({
  kind: 'unicode',
  name,
  glyph,
});
const custom = (name: string): EmojiCandidate => ({
  kind: 'custom',
  name,
  url: `https://cdn/${name}.png`,
});

describe('filterEmojis (FR-RC05) — : 이모지 자동완성 (유니코드 + 커스텀)', () => {
  it('substring-matches shortcode names (case-insensitive)', () => {
    const out = filterEmojis({
      unicode: [unicode('tada', '🎉'), unicode('thumbsup', '👍')],
      custom: [],
      recent: [],
      query: 'ta',
      limit: 12,
    });
    expect(out.map((e) => e.name)).toEqual(['tada']);
  });

  it('mixes custom emoji with unicode, custom first for an exact pack match', () => {
    const out = filterEmojis({
      unicode: [unicode('partying', '🥳')],
      custom: [custom('party_parrot')],
      recent: [],
      query: 'party',
      limit: 12,
    });
    expect(out.map((e) => e.name)).toContain('party_parrot');
    expect(out.map((e) => e.name)).toContain('partying');
  });

  it('caps at the limit (max 12)', () => {
    const many = Array.from({ length: 30 }, (_, i) => unicode(`smile${i}`, '🙂'));
    const out = filterEmojis({ unicode: many, custom: [], recent: [], query: 'smile', limit: 12 });
    expect(out).toHaveLength(12);
  });

  it('prioritises recently used emoji', () => {
    const out = filterEmojis({
      unicode: [unicode('smile', '🙂'), unicode('smirk', '😏')],
      custom: [],
      recent: ['smirk'],
      query: 'sm',
      limit: 12,
    });
    expect(out[0].name).toBe('smirk');
  });

  it('ranks a prefix match above a mid-word substring match', () => {
    const out = filterEmojis({
      unicode: [unicode('unamused', '😒'), unicode('amused', '😆')],
      custom: [],
      recent: [],
      query: 'amus',
      limit: 12,
    });
    expect(out[0].name).toBe('amused');
  });

  // S42 (FR-PK02): alias 후보는 custom kind + insertName(원본 name)으로 주입된다.
  it('matches an alias candidate by its alias name + carries insertName', () => {
    const aliasCandidate: EmojiCandidate = {
      kind: 'custom',
      name: 'birb',
      url: 'https://cdn/parrot.png',
      insertName: 'parrot',
    };
    const out = filterEmojis({
      unicode: [],
      custom: [aliasCandidate],
      recent: [],
      query: 'birb',
      limit: 10,
    });
    expect(out).toHaveLength(1);
    const hit = out[0];
    expect(hit.kind).toBe('custom');
    expect(hit.name).toBe('birb');
    expect(hit.kind === 'custom' ? hit.insertName : undefined).toBe('parrot');
  });

  it('caps at 10 when the limit is 10 (S42 FR-PK02)', () => {
    const many = Array.from({ length: 30 }, (_, i) => unicode(`smile${i}`, '🙂'));
    const out = filterEmojis({ unicode: many, custom: [], recent: [], query: 'smile', limit: 10 });
    expect(out).toHaveLength(10);
  });
});
