import { describe, it, expect } from 'vitest';
import { zeroOutChannelUnread, type UnreadChannelSummary } from './useUnread';

/**
 * S22 review #5: 채널 open 낙관 패치 + useMarkChannelRead.onSuccess 가
 * 공유하는 zero-out 헬퍼. `unreadCount`/`mentionCount`/`hasMention` 셋 모두
 * 0/false 로 눌러야 사이드바 멘션 배지 깜빡임이 사라진다(예전엔 낙관 패치가
 * mentionCount 를 누락해 onSuccess refetch 전까지 멘션 숫자가 잠깐 남았다).
 */
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

describe('zeroOutChannelUnread (S22 review #5)', () => {
  it('zeros unreadCount AND mentionCount AND hasMention for the target channel', () => {
    const old = {
      channels: [
        summary({ channelId: 'target', unreadCount: 7, mentionCount: 3, hasMention: true }),
      ],
    };
    const next = zeroOutChannelUnread(old, 'target');
    expect(next?.channels[0]).toMatchObject({
      channelId: 'target',
      unreadCount: 0,
      mentionCount: 0,
      hasMention: false,
    });
  });

  it('leaves other channels untouched', () => {
    const old = {
      channels: [
        summary({ channelId: 'target', unreadCount: 5, mentionCount: 2, hasMention: true }),
        summary({ channelId: 'other', unreadCount: 9, mentionCount: 4, hasMention: true }),
      ],
    };
    const next = zeroOutChannelUnread(old, 'target');
    expect(next?.channels[1]).toMatchObject({
      channelId: 'other',
      unreadCount: 9,
      mentionCount: 4,
      hasMention: true,
    });
  });

  it('returns the same undefined when cache is empty', () => {
    expect(zeroOutChannelUnread(undefined, 'whatever')).toBeUndefined();
  });

  it('is a no-op shape when channelId is absent from the cache', () => {
    const old = { channels: [summary({ channelId: 'a', unreadCount: 1, mentionCount: 1 })] };
    const next = zeroOutChannelUnread(old, 'missing');
    expect(next?.channels[0]).toMatchObject({ channelId: 'a', unreadCount: 1, mentionCount: 1 });
  });
});
