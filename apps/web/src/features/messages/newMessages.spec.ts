import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  computeFirstUnreadIndex,
  shouldShowJumpPill,
  buildRowPlan,
  messageIndexForVirtualIndex,
  virtualIndexForMessageIndex,
  virtualIndexForDivider,
  lastRowVirtualIndex,
  captureUnreadSnapshot,
  firstVisibleIndex,
  type FirstUnreadInput,
  type VisibleRow,
} from './newMessages';

/**
 * S23 (FR-RS-06/07): NEW MESSAGES 구분선 firstUnread 계산 + Jump-to-Unread
 * pill 표시 판정의 순수 로직 단위 테스트. 가상화/DOM 비의존(node 환경).
 */
beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('computeFirstUnreadIndex (FR-RS-06)', () => {
  const ids = ['m1', 'm2', 'm3', 'm4', 'm5'];

  it('lastReadMessageId 직후 첫 메시지의 index 를 반환', () => {
    const input: FirstUnreadInput = {
      messageIds: ids,
      lastReadMessageId: 'm3',
      unreadCount: 2,
    };
    expect(computeFirstUnreadIndex(input)).toBe(3); // m4
  });

  it('읽지 않음이 없으면(unreadCount 0) null — 구분선 미표시', () => {
    const input: FirstUnreadInput = {
      messageIds: ids,
      lastReadMessageId: 'm5',
      unreadCount: 0,
    };
    expect(computeFirstUnreadIndex(input)).toBeNull();
  });

  it('lastRead 가 마지막 메시지면(직후 메시지 없음) null', () => {
    const input: FirstUnreadInput = {
      messageIds: ids,
      lastReadMessageId: 'm5',
      unreadCount: 1,
    };
    // 커서가 끝에 있고 직후 메시지가 없으면 표시할 위치가 없다.
    expect(computeFirstUnreadIndex(input)).toBeNull();
  });

  it('lastReadMessageId 가 배열에 없고 unreadCount 로 끝에서 역산', () => {
    // around-reload 로 lastRead 메시지가 윈도우 밖이거나 store 미보유 →
    // unreadCount 만큼이 읽지 않음: 끝에서 unreadCount 번째가 firstUnread.
    const input: FirstUnreadInput = {
      messageIds: ids,
      lastReadMessageId: null,
      unreadCount: 2,
    };
    expect(computeFirstUnreadIndex(input)).toBe(3); // m4, m5 가 읽지 않음
  });

  it('lastReadMessageId 미보유 + unreadCount 가 전체보다 크면 index 0', () => {
    const input: FirstUnreadInput = {
      messageIds: ids,
      lastReadMessageId: null,
      unreadCount: 99,
    };
    expect(computeFirstUnreadIndex(input)).toBe(0);
  });

  it('빈 목록이면 null', () => {
    expect(
      computeFirstUnreadIndex({ messageIds: [], lastReadMessageId: null, unreadCount: 3 }),
    ).toBeNull();
  });

  it('lastReadMessageId 가 배열에 있으나 직후가 비면(끝) null 우선', () => {
    const input: FirstUnreadInput = {
      messageIds: ids,
      lastReadMessageId: 'm5',
      unreadCount: 5,
    };
    // id 기반이 우선 — 커서가 끝에 있으니 표시 불가(unreadCount 가 stale).
    expect(computeFirstUnreadIndex(input)).toBeNull();
  });
});

describe('shouldShowJumpPill (FR-RS-07)', () => {
  it('구분선이 없으면(dividerIndex null) 숨김', () => {
    expect(shouldShowJumpPill({ firstRenderedIndex: 10, dividerIndex: null })).toBe(false);
  });

  it('첫 렌더 인덱스가 구분선보다 아래면(위로 벗어남) 표시', () => {
    expect(shouldShowJumpPill({ firstRenderedIndex: 8, dividerIndex: 3 })).toBe(true);
  });

  it('구분선이 첫 렌더 윈도우 안이면 숨김', () => {
    expect(shouldShowJumpPill({ firstRenderedIndex: 2, dividerIndex: 3 })).toBe(false);
  });

  it('첫 렌더 인덱스 == 구분선 인덱스면(경계, 보임) 숨김', () => {
    expect(shouldShowJumpPill({ firstRenderedIndex: 3, dividerIndex: 3 })).toBe(false);
  });

  it('첫 렌더 인덱스 미정(null)이면 숨김', () => {
    expect(shouldShowJumpPill({ firstRenderedIndex: null, dividerIndex: 3 })).toBe(false);
  });
});

describe('firstVisibleIndex — overscan 보정(S23 MAJOR fix)', () => {
  // 행 높이 64px. 가상화가 뷰포트 위 overscan 으로 인덱스 0..n 을 마운트하지만,
  // scrollTop 기준 실제 보이는 최상단만 골라야 한다.
  const H = 64;
  function rows(from: number, to: number): VisibleRow[] {
    const out: VisibleRow[] = [];
    for (let i = from; i <= to; i += 1) out.push({ index: i, start: i * H, size: H });
    return out;
  }

  it('빈 목록이면 null', () => {
    expect(firstVisibleIndex([], 0)).toBeNull();
  });

  it('scrollTop=0 이면 첫 행이 보이는 최상단', () => {
    expect(firstVisibleIndex(rows(0, 10), 0)).toBe(0);
  });

  it('overscan 으로 위 8행이 마운트돼도 scrollTop 으로 실제 보이는 최상단을 고른다', () => {
    // 사용자가 인덱스 10 근처를 보고 있음(scrollTop = 10*64 = 640). 가상화는
    // overscan 으로 2..18 을 마운트하지만 보이는 최상단은 10 이어야 한다.
    // (종전 items[0].index=2 라 구분선(예: index 5)이 화면 밖인데 숨었다.)
    const mounted = rows(2, 18);
    expect(firstVisibleIndex(mounted, 640)).toBe(10);
  });

  it('overscan 보정 후 구분선이 화면 밖(위)이면 pill 표시', () => {
    // 구분선 가상행 index 5. 보이는 최상단 10 > 5 → 위로 벗어남 → pill.
    const mounted = rows(2, 18);
    const firstVisible = firstVisibleIndex(mounted, 640);
    expect(shouldShowJumpPill({ firstRenderedIndex: firstVisible, dividerIndex: 5 })).toBe(true);
  });

  it('행 하단이 scrollTop 을 살짝 넘는 부분 가시 행도 보이는 최상단으로 친다', () => {
    // scrollTop=630 → 인덱스 9(start=576,end=640)의 하단이 630 을 넘으므로 9 가
    // 보이는 최상단(부분 가시).
    expect(firstVisibleIndex(rows(2, 18), 630)).toBe(9);
  });
});

describe('buildRowPlan — 구분선 별도 행 삽입(FR-RS-06 가상화)', () => {
  it('구분선이 없으면(dividerIndex null) 행 수 = 메시지 수, 전부 message 행', () => {
    const plan = buildRowPlan({ messageCount: 4, dividerIndex: null });
    expect(plan.count).toBe(4);
    expect(messageIndexForVirtualIndex(plan, 0)).toBe(0);
    expect(messageIndexForVirtualIndex(plan, 3)).toBe(3);
    expect(virtualIndexForDivider(plan)).toBeNull();
  });

  it('구분선이 index 2 면 행 수 = 메시지+1, 구분선이 메시지2 앞 가상행', () => {
    const plan = buildRowPlan({ messageCount: 5, dividerIndex: 2 });
    expect(plan.count).toBe(6);
    // 가상 0,1 → 메시지 0,1
    expect(messageIndexForVirtualIndex(plan, 0)).toBe(0);
    expect(messageIndexForVirtualIndex(plan, 1)).toBe(1);
    // 가상 2 → 구분선 행(메시지 아님 → null)
    expect(messageIndexForVirtualIndex(plan, 2)).toBeNull();
    expect(virtualIndexForDivider(plan)).toBe(2);
    // 가상 3,4,5 → 메시지 2,3,4 (구분선 이후 한 칸 밀림)
    expect(messageIndexForVirtualIndex(plan, 3)).toBe(2);
    expect(messageIndexForVirtualIndex(plan, 4)).toBe(3);
    expect(messageIndexForVirtualIndex(plan, 5)).toBe(4);
  });

  it('구분선이 index 0(전부 읽지 않음)이면 맨 앞 가상행이 구분선', () => {
    const plan = buildRowPlan({ messageCount: 3, dividerIndex: 0 });
    expect(plan.count).toBe(4);
    expect(virtualIndexForDivider(plan)).toBe(0);
    expect(messageIndexForVirtualIndex(plan, 0)).toBeNull();
    expect(messageIndexForVirtualIndex(plan, 1)).toBe(0);
    expect(messageIndexForVirtualIndex(plan, 3)).toBe(2);
  });

  it('virtualIndexForMessageIndex 는 messageIndexForVirtualIndex 의 역', () => {
    const plan = buildRowPlan({ messageCount: 5, dividerIndex: 2 });
    // 메시지 0,1 → 가상 0,1 (구분선 앞)
    expect(virtualIndexForMessageIndex(plan, 0)).toBe(0);
    expect(virtualIndexForMessageIndex(plan, 1)).toBe(1);
    // 메시지 2,3,4 → 가상 3,4,5 (구분선 뒤로 한 칸 밀림)
    expect(virtualIndexForMessageIndex(plan, 2)).toBe(3);
    expect(virtualIndexForMessageIndex(plan, 4)).toBe(5);
    // 왕복 항등
    for (let m = 0; m < 5; m += 1) {
      expect(messageIndexForVirtualIndex(plan, virtualIndexForMessageIndex(plan, m))).toBe(m);
    }
  });

  it('구분선 없으면 virtualIndexForMessageIndex 항등', () => {
    const plan = buildRowPlan({ messageCount: 5, dividerIndex: null });
    expect(virtualIndexForMessageIndex(plan, 3)).toBe(3);
  });

  it('lastRowVirtualIndex 는 항상 마지막 가상행(= count-1)', () => {
    expect(lastRowVirtualIndex(buildRowPlan({ messageCount: 5, dividerIndex: 2 }))).toBe(5);
    expect(lastRowVirtualIndex(buildRowPlan({ messageCount: 5, dividerIndex: null }))).toBe(4);
    expect(lastRowVirtualIndex(buildRowPlan({ messageCount: 0, dividerIndex: null }))).toBe(-1);
  });
});

describe('captureUnreadSnapshot — cold 캐시 구분선(S23 MAJOR fix)', () => {
  const ids = ['m1', 'm2', 'm3', 'm4', 'm5'];

  it('cold summary(미캐시)여도 lastReadMessageId 가 있으면 구분선이 표시된다', () => {
    // 채널 첫 방문 / staleTime 만료 → unread-summary 캐시에 채널 행이 없다
    // (cachedUnreadCount=undefined → 0 폴백). 하지만 readStateStore 의
    // lastReadMessageId 가 남아 있으면 구분선은 lastRead 직후로 판정된다.
    const snap = captureUnreadSnapshot({
      cachedUnreadCount: undefined,
      lastReadMessageId: 'm3',
    });
    expect(snap.unreadCount).toBe(0);
    expect(snap.lastReadMessageId).toBe('m3');
    const idx = computeFirstUnreadIndex({
      messageIds: ids,
      lastReadMessageId: snap.lastReadMessageId,
      unreadCount: snap.unreadCount,
    });
    expect(idx).toBe(3); // m4 — cold 캐시에서도 구분선이 사라지지 않는다
  });

  it('warm summary 면 unreadCount 를 보존한다', () => {
    const snap = captureUnreadSnapshot({ cachedUnreadCount: 2, lastReadMessageId: null });
    expect(snap.unreadCount).toBe(2);
    expect(snap.lastReadMessageId).toBeNull();
    // lastRead 미보유여도 unreadCount 역산으로 구분선 판정.
    expect(
      computeFirstUnreadIndex({
        messageIds: ids,
        lastReadMessageId: snap.lastReadMessageId,
        unreadCount: snap.unreadCount,
      }),
    ).toBe(3);
  });

  it('cold + lastRead 둘 다 없으면 구분선 미표시(읽지 않음 0)', () => {
    const snap = captureUnreadSnapshot({ cachedUnreadCount: undefined, lastReadMessageId: null });
    expect(snap).toEqual({ unreadCount: 0, lastReadMessageId: null });
    expect(
      computeFirstUnreadIndex({
        messageIds: ids,
        lastReadMessageId: snap.lastReadMessageId,
        unreadCount: snap.unreadCount,
      }),
    ).toBeNull();
  });
});
