import { describe, it, expect, beforeEach, vi } from 'vitest';
import { filterChannels, type RankableChannel } from './filterChannels';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

const c = (name: string, topic?: string): RankableChannel => ({
  id: name,
  name,
  topic: topic ?? null,
});

describe('filterChannels (FR-RC04) — # 채널 prefix 필터', () => {
  it('keeps prefix matches (case-insensitive) and caps the list', () => {
    const out = filterChannels({
      channels: [c('general'), c('gaming'), c('random')],
      query: 'g',
      limit: 8,
    });
    expect(out.map((x) => x.name)).toEqual(['gaming', 'general']);
  });

  it('returns all channels (capped) for an empty query', () => {
    const out = filterChannels({
      channels: [c('a'), c('b')],
      query: '',
      limit: 8,
    });
    expect(out).toHaveLength(2);
  });

  it('preserves topic for the __sub preview', () => {
    const out = filterChannels({
      channels: [c('general', '잡담 채널')],
      query: 'gen',
      limit: 8,
    });
    expect(out[0].topic).toBe('잡담 채널');
  });

  it('respects the limit', () => {
    const channels = Array.from({ length: 12 }, (_, i) => c(`ch${i}`));
    const out = filterChannels({ channels, query: '', limit: 8 });
    expect(out).toHaveLength(8);
  });
});
