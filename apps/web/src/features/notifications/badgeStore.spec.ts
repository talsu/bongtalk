import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useBadgeStore } from './badgeStore';

/**
 * S47 (FR-MN-20): 배지 스토어 — server last-write-wins + ACK 우선 stale 가드.
 */
describe('badgeStore (S47 · FR-MN-20)', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    useBadgeStore.getState().reset();
  });

  it('badge_update 는 서버 진실값으로 카운트를 교체한다(last-write-wins)', () => {
    const s = useBadgeStore.getState();
    s.bumpOptimistic({ workspaceId: 'ws-1', mention: true }); // 낙관적 +1
    expect(useBadgeStore.getState().byWorkspace['ws-1'].mentionCount).toBe(1);

    s.applyServerUpdate({
      workspaceId: 'ws-1',
      mentionCount: 5,
      unreadCount: 12,
      serverTimestamp: '2025-01-01T00:00:01.000Z',
    });
    const e = useBadgeStore.getState().byWorkspace['ws-1'];
    expect(e.mentionCount).toBe(5);
    expect(e.unreadCount).toBe(12);
  });

  it('out-of-order(더 과거의) badge_update 는 무시한다', () => {
    const s = useBadgeStore.getState();
    s.applyServerUpdate({
      workspaceId: 'ws-1',
      mentionCount: 5,
      unreadCount: 12,
      serverTimestamp: '2025-01-01T00:00:05.000Z',
    });
    // 더 과거 timestamp → 무시.
    s.applyServerUpdate({
      workspaceId: 'ws-1',
      mentionCount: 1,
      unreadCount: 1,
      serverTimestamp: '2025-01-01T00:00:02.000Z',
    });
    const e = useBadgeStore.getState().byWorkspace['ws-1'];
    expect(e.mentionCount).toBe(5);
    expect(e.unreadCount).toBe(12);
  });

  it('ACK 응답 이후 시각 기준 더 이른 badge_update 는 stale 로 무시한다(ACK 우선)', () => {
    const s = useBadgeStore.getState();
    // T0 에 ACK — unreadCount 0 으로 즉시 갱신 + lastAckedAt = now(2025-01-01T00:00:00Z).
    s.applyAck({ workspaceId: 'ws-1', unreadCount: 0, mentionCount: 0 });
    expect(useBadgeStore.getState().byWorkspace['ws-1'].unreadCount).toBe(0);

    // ACK 시각보다 이른(過去) serverTimestamp 의 badge_update 도착 → stale, 무시.
    s.applyServerUpdate({
      workspaceId: 'ws-1',
      mentionCount: 7,
      unreadCount: 7,
      serverTimestamp: '2024-12-31T23:59:59.000Z',
    });
    expect(useBadgeStore.getState().byWorkspace['ws-1'].unreadCount).toBe(0);
    expect(useBadgeStore.getState().byWorkspace['ws-1'].mentionCount).toBe(0);
  });

  it('markAcked 는 카운트는 두고 lastAckedAt 만 전진해 이후 stale badge_update 를 거른다', () => {
    const s = useBadgeStore.getState();
    // 먼저 서버값으로 채운다.
    s.applyServerUpdate({
      workspaceId: 'ws-1',
      mentionCount: 4,
      unreadCount: 9,
      serverTimestamp: '2025-01-01T00:00:00.000Z',
    });
    // 채널 ACK — 시각만 전진(now=2025-01-01T00:00:00Z), 카운트 보존.
    s.markAcked('ws-1');
    expect(useBadgeStore.getState().byWorkspace['ws-1'].mentionCount).toBe(4);

    // ACK 보다 이른 badge_update → 무시.
    s.applyServerUpdate({
      workspaceId: 'ws-1',
      mentionCount: 99,
      unreadCount: 99,
      serverTimestamp: '2024-12-31T00:00:00.000Z',
    });
    expect(useBadgeStore.getState().byWorkspace['ws-1'].mentionCount).toBe(4);
  });

  it('ACK 이후라도 더 최신(미래) badge_update 는 반영한다', () => {
    const s = useBadgeStore.getState();
    s.applyAck({ workspaceId: 'ws-1', unreadCount: 0 });
    s.applyServerUpdate({
      workspaceId: 'ws-1',
      mentionCount: 2,
      unreadCount: 3,
      serverTimestamp: '2025-01-01T00:00:10.000Z',
    });
    const e = useBadgeStore.getState().byWorkspace['ws-1'];
    expect(e.mentionCount).toBe(2);
    expect(e.unreadCount).toBe(3);
  });

  it('replaceAll 은 전체를 서버 진실값으로 교체하고 lastAckedAt 은 보존한다', () => {
    const s = useBadgeStore.getState();
    s.applyAck({ workspaceId: 'ws-1', unreadCount: 0 });
    const ackedAt = useBadgeStore.getState().byWorkspace['ws-1'].lastAckedAt;

    s.replaceAll([
      { workspaceId: 'ws-1', mentionCount: 4, unreadCount: 8 },
      { workspaceId: 'ws-2', mentionCount: 0, unreadCount: 2 },
    ]);
    const st = useBadgeStore.getState();
    expect(st.byWorkspace['ws-1'].mentionCount).toBe(4);
    expect(st.byWorkspace['ws-1'].lastAckedAt).toBe(ackedAt);
    expect(st.byWorkspace['ws-2'].unreadCount).toBe(2);
  });

  it('글로벌 합계(totalUnread/totalMention)는 모든 워크스페이스의 합이다', () => {
    const s = useBadgeStore.getState();
    s.replaceAll([
      { workspaceId: 'ws-1', mentionCount: 2, unreadCount: 5 },
      { workspaceId: 'ws-2', mentionCount: 3, unreadCount: 7 },
    ]);
    expect(useBadgeStore.getState().totalUnread()).toBe(12);
    expect(useBadgeStore.getState().totalMention()).toBe(5);
  });
});
