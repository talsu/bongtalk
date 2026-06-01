import { describe, it, expect, beforeEach, vi } from 'vitest';
import { zeroOutAllChannels, type UnreadChannelSummary } from './useUnread';

/**
 * S23 (FR-RS-11): 워크스페이스 전체 읽음(Shift+Esc) 낙관 패치 — 요약 캐시의
 * 모든 채널을 unreadCount/mentionCount/hasMention 전부 0/false 로 누른다.
 */
beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

function summary(
  partial: Partial<UnreadChannelSummary> & { channelId: string },
): UnreadChannelSummary {
  return {
    channelId: partial.channelId,
    unreadCount: partial.unreadCount ?? 0,
    mentionCount: partial.mentionCount ?? 0,
    hasMention: partial.hasMention ?? false,
    lastMessageAt: partial.lastMessageAt ?? null,
  };
}

describe('zeroOutAllChannels (FR-RS-11)', () => {
  it('모든 채널의 unread/mention/hasMention 을 0/false 로 누른다', () => {
    const old = {
      channels: [
        summary({ channelId: 'a', unreadCount: 4, mentionCount: 2, hasMention: true }),
        summary({ channelId: 'b', unreadCount: 9, mentionCount: 0, hasMention: false }),
      ],
    };
    const next = zeroOutAllChannels(old);
    expect(next?.channels).toEqual([summary({ channelId: 'a' }), summary({ channelId: 'b' })]);
  });

  it('캐시가 비면(undefined) 그대로 반환', () => {
    expect(zeroOutAllChannels(undefined)).toBeUndefined();
  });

  it('빈 채널 목록도 안전', () => {
    expect(zeroOutAllChannels({ channels: [] })).toEqual({ channels: [] });
  });
});
