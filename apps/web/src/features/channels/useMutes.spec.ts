import { describe, it, expect, beforeEach, vi } from 'vitest';
import { activeMutedChannelIds, type ActiveMute } from './useMutes';

/**
 * 사이드바 억제 판정은 channelId·mutedUntil 만 본다(S49 보강 필드 무관). 픽스처는
 * 그 두 필드만 갖춘 부분 타입으로 둔다 — activeMutedChannelIds 가 Pick 시그니처를
 * 받으므로 보강 필드(channelName 등) 없이도 타입 안전하다.
 */
type MuteFixture = Pick<ActiveMute, 'channelId' | 'mutedUntil'>;

/**
 * S22 review #8: 뮤트 만료 클라 1차 필터.
 *
 * 서버는 활성 행만 내려주지만 캐시된 응답에서 `mutedUntil` 이 미래→과거로
 * 넘어가면 다음 refetch 전까지 억제가 지속된다. `activeMutedChannelIds` 가
 * 클라 시계(now)로 만료 항목을 즉시 제외하는지 검증한다.
 */
describe('activeMutedChannelIds (S22 review #8 mute expiry filter)', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  });

  const NOW = Date.parse('2025-01-01T00:00:00Z');

  it('includes indefinite mutes (mutedUntil = null)', () => {
    const items: MuteFixture[] = [{ channelId: 'c1', mutedUntil: null }];
    const set = activeMutedChannelIds(items, NOW);
    expect(set.has('c1')).toBe(true);
  });

  it('includes mutes that expire in the future', () => {
    const items: MuteFixture[] = [{ channelId: 'c1', mutedUntil: '2025-01-01T01:00:00Z' }];
    expect(activeMutedChannelIds(items, NOW).has('c1')).toBe(true);
  });

  it('excludes mutes whose mutedUntil has already passed', () => {
    const items: MuteFixture[] = [{ channelId: 'expired', mutedUntil: '2024-12-31T23:59:59Z' }];
    expect(activeMutedChannelIds(items, NOW).has('expired')).toBe(false);
  });

  it('excludes a mute at the exact boundary (mutedUntil == now)', () => {
    // > now 이므로 == now 는 만료로 본다(억제 해제).
    const items: MuteFixture[] = [{ channelId: 'boundary', mutedUntil: '2025-01-01T00:00:00Z' }];
    expect(activeMutedChannelIds(items, NOW).has('boundary')).toBe(false);
  });

  it('keeps only the non-expired subset across a mixed list', () => {
    const items: MuteFixture[] = [
      { channelId: 'live-null', mutedUntil: null },
      { channelId: 'live-future', mutedUntil: '2025-01-02T00:00:00Z' },
      { channelId: 'dead-past', mutedUntil: '2024-01-01T00:00:00Z' },
    ];
    const set = activeMutedChannelIds(items, NOW);
    expect([...set].sort()).toEqual(['live-future', 'live-null']);
  });

  it('returns an empty set for no items', () => {
    expect(activeMutedChannelIds([], NOW).size).toBe(0);
  });
});
