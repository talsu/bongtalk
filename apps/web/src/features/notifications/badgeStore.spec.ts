import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useBadgeStore } from './badgeStore';

/**
 * S47 (FR-MN-20): 배지 스토어 — server last-write-wins + ACK 우선 stale 가드.
 * S47 fix-forward (BLOCKER-2): ACK 경로가 서버 시계(serverTimestamp)로 lastAckedAt
 * 을 저장해 교차시계 폐기 버그를 제거한다(skew 테스트 포함).
 */
describe('badgeStore (S47 · FR-MN-20)', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    useBadgeStore.getState().reset();
  });

  it('badge_update 는 서버 진실값으로 카운트를 교체한다(last-write-wins)', () => {
    const s = useBadgeStore.getState();
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

  it('markAcked(서버시각) 이후 더 이른 badge_update 는 stale 로 무시한다(ACK 우선)', () => {
    const s = useBadgeStore.getState();
    s.applyServerUpdate({
      workspaceId: 'ws-1',
      mentionCount: 4,
      unreadCount: 9,
      serverTimestamp: '2025-01-01T00:00:05.000Z',
    });
    // 채널 ACK — 서버 시각 T+10 만 기록(카운트 보존).
    s.markAcked('ws-1', '2025-01-01T00:00:10.000Z');
    expect(useBadgeStore.getState().byWorkspace['ws-1'].mentionCount).toBe(4);

    // ACK 보다 이른(過去) serverTimestamp 의 badge_update → stale, 무시.
    s.applyServerUpdate({
      workspaceId: 'ws-1',
      mentionCount: 99,
      unreadCount: 99,
      serverTimestamp: '2025-01-01T00:00:08.000Z',
    });
    expect(useBadgeStore.getState().byWorkspace['ws-1'].mentionCount).toBe(4);
  });

  it('ACK 이후라도 더 최신 badge_update 는 반영한다', () => {
    const s = useBadgeStore.getState();
    s.markAcked('ws-1', '2025-01-01T00:00:05.000Z');
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

  it('BLOCKER-2 skew: 서버 시계가 클라보다 뒤처져도 ACK 직후 신규 badge_update 가 폐기되지 않는다', () => {
    // 시나리오: 클라 벽시계(Date.now) 는 T+30s 이지만, 서버 시계는 T+5s 로 뒤처짐.
    // 종전 버그: markAcked 가 클라 Date.now()(T+30s) 를 lastAckedAt 으로 찍어,
    //           서버 시계로 찍힌 신규 badge_update.serverTimestamp(T+6s < T+30s)가
    //           stale 로 폐기됐다(배지 누락).
    // 수정: markAcked 가 서버 ACK 시각(T+5s)을 저장 → T+6s 신규 update 는 더 최신이라 반영.
    vi.setSystemTime(new Date('2025-01-01T00:00:30Z')); // 클라 벽시계: 앞섬
    const s = useBadgeStore.getState();
    // 서버가 read_state:updated 에 실어 보낸 ACK 시각(서버 시계) = T+5s.
    s.markAcked('ws-1', '2025-01-01T00:00:05.000Z');
    expect(useBadgeStore.getState().byWorkspace['ws-1'].lastAckedAt).toBe(
      new Date('2025-01-01T00:00:05.000Z').getTime(),
    );

    // 정당한 신규 badge_update(서버 시계 T+6s, 방금 set 한 lastAckedAt 보다 약간 이후).
    s.applyServerUpdate({
      workspaceId: 'ws-1',
      mentionCount: 3,
      unreadCount: 7,
      serverTimestamp: '2025-01-01T00:00:06.000Z',
    });
    const e = useBadgeStore.getState().byWorkspace['ws-1'];
    // 폐기되지 않고 반영돼야 한다(skew 버그였다면 0 으로 남았을 것).
    expect(e.mentionCount).toBe(3);
    expect(e.unreadCount).toBe(7);
  });

  it('markAcked 는 後進하지 않는다(더 이른 ACK 시각이 뒤늦게 도착해도 무시)', () => {
    const s = useBadgeStore.getState();
    s.markAcked('ws-1', '2025-01-01T00:00:10.000Z');
    s.markAcked('ws-1', '2025-01-01T00:00:03.000Z'); // 後進 시도 → 무시
    expect(useBadgeStore.getState().byWorkspace['ws-1'].lastAckedAt).toBe(
      new Date('2025-01-01T00:00:10.000Z').getTime(),
    );
  });

  it('replaceAll 은 전체를 서버 진실값으로 교체하고 lastAckedAt 은 보존한다', () => {
    const s = useBadgeStore.getState();
    s.markAcked('ws-1', '2025-01-01T00:00:05.000Z');
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

// S69 (FR-W20/W23): unread_count:increment 낙관 갱신 + connection:ready 멘션 복원.
describe('badgeStore S69 (FR-W23 optimistic increment)', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    useBadgeStore.getState().reset();
  });

  it('applyOptimisticIncrement 는 workspaceId 기준 unreadCount 를 +delta 낙관 갱신한다', () => {
    const s = useBadgeStore.getState();
    s.applyOptimisticIncrement('ws-1', 1);
    s.applyOptimisticIncrement('ws-1', 2);
    expect(useBadgeStore.getState().byWorkspace['ws-1'].unreadCount).toBe(3);
    // 다른 워크스페이스는 영향받지 않는다.
    expect(useBadgeStore.getState().byWorkspace['ws-2']).toBeUndefined();
  });

  // S69 fix-forward (reviewer MAJOR-2): unread_count:increment 는 멘션 전용 이벤트라
  // mentionCount 도 함께 +delta 해야 한다(멘션 빨간 배지 즉시 반영).
  it('applyOptimisticIncrement 는 mentionCount 도 +delta 한다(멘션 전용 이벤트)', () => {
    const s = useBadgeStore.getState();
    s.applyOptimisticIncrement('ws-1', 1);
    s.applyOptimisticIncrement('ws-1', 2);
    expect(useBadgeStore.getState().byWorkspace['ws-1'].mentionCount).toBe(3);
  });

  it('unreadCount/mentionCount 는 0 미만으로 내려가지 않는다(음수 delta clamp)', () => {
    const s = useBadgeStore.getState();
    s.applyOptimisticIncrement('ws-1', 1);
    s.applyOptimisticIncrement('ws-1', -5);
    expect(useBadgeStore.getState().byWorkspace['ws-1'].unreadCount).toBe(0);
    expect(useBadgeStore.getState().byWorkspace['ws-1'].mentionCount).toBe(0);
  });

  it('직후 도착한 서버 진실값(applyServerUpdate)이 낙관값을 교정한다', () => {
    const s = useBadgeStore.getState();
    s.applyOptimisticIncrement('ws-1', 3);
    s.applyServerUpdate({
      workspaceId: 'ws-1',
      mentionCount: 0,
      unreadCount: 1,
      serverTimestamp: '2025-01-01T00:00:05.000Z',
    });
    expect(useBadgeStore.getState().byWorkspace['ws-1'].unreadCount).toBe(1);
  });

  it('applyConnectionMentionCounts 는 가입 워크스페이스별 멘션 카운트를 채운다', () => {
    const s = useBadgeStore.getState();
    s.applyConnectionMentionCounts([
      { workspaceId: 'ws-1', mentionCount: 4 },
      { workspaceId: 'ws-2', mentionCount: 0 },
    ]);
    expect(useBadgeStore.getState().byWorkspace['ws-1'].mentionCount).toBe(4);
    expect(useBadgeStore.getState().byWorkspace['ws-2'].mentionCount).toBe(0);
  });

  it('applyConnectionMentionCounts 는 기존 unreadCount/lastAckedAt 을 보존한다', () => {
    const s = useBadgeStore.getState();
    s.applyOptimisticIncrement('ws-1', 2);
    s.markAcked('ws-1', '2025-01-01T00:00:03.000Z');
    s.applyConnectionMentionCounts([{ workspaceId: 'ws-1', mentionCount: 9 }]);
    const e = useBadgeStore.getState().byWorkspace['ws-1'];
    expect(e.mentionCount).toBe(9);
    expect(e.unreadCount).toBe(2);
    expect(e.lastAckedAt).toBeGreaterThan(0);
  });
});
