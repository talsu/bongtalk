import { create } from 'zustand';

/**
 * S47 (D06 / FR-MN-14 / FR-MN-20): 서버 단위 알림 배지 스토어.
 *
 * workspaceId(=serverId) → { mentionCount, unreadCount } 를 들고 있으며, 세 경로가
 * 이 스토어를 갱신한다:
 *
 *  1. notification:badge_update WS 이벤트 → applyServerUpdate(server last-write-wins).
 *     단 serverTimestamp 가 그 워크스페이스의 lastAckedAt 보다 이르면 **stale 로 무시**
 *     한다(ACK 우선 — FR-MN-20).
 *  2. read_state:updated(채널 ACK) → markAcked(서버 timestamp 기록). 단일 채널 ACK
 *     로는 워크스페이스 합계를 정확히 알 수 없으므로 카운트는 건드리지 않고 ACK 시각
 *     (서버 시계)만 기록해, 이후 도착하는 더 이른 badge_update 를 거른다.
 *  3. GET /me/notification-badges 재동기화 → replaceAll(전체 교체, 서버 진실값).
 *
 * ── S47 fix-forward (BLOCKER-2): 교차시계 비교 제거 ──
 * 종전 markAcked 는 lastAckedAt 을 클라 Date.now() 로 찍고, applyServerUpdate 는 서버
 * 의 serverTimestamp(ISO) 와 그 클라 시각을 비교했다. 서버 시계가 클라보다 뒤처지면
 * 정당한 신규 badge_update.serverTimestamp 가 방금 찍은 클라 lastAckedAt 보다 이르게
 * 평가돼 stale 로 폐기됐다(배지 누락 → resync 전까지 잘못된 0). 이제 markAcked 는
 * **서버가 read_state:updated 에 실어 보낸 serverTimestamp(서버 시계)** 로 lastAckedAt
 * 을 저장한다. badge_update 도 같은 서버 시계로 찍히므로 동일 시계 비교가 되어, 서버
 * 지연 상황에서도 신규 badge_update 가 stale 로 폐기되지 않는다.
 *
 * 시각 비교는 epoch ms 로 한다(ISO → parseTs).
 */
export interface BadgeEntry {
  mentionCount: number;
  unreadCount: number;
  /** 마지막으로 반영한 서버 badge_update 의 serverTimestamp(epoch ms). 없으면 0. */
  lastServerTs: number;
  /** 마지막 ACK 의 서버 시각(epoch ms). 이보다 이른 badge_update 는 stale 로 무시. */
  lastAckedAt: number;
}

interface BadgeStoreState {
  byWorkspace: Record<string, BadgeEntry>;
  /** FR-MN-20: badge_update WS 이벤트 반영(server last-write-wins · ACK-우선 stale 가드). */
  applyServerUpdate: (args: {
    workspaceId: string;
    mentionCount: number;
    unreadCount: number;
    serverTimestamp: string;
  }) => void;
  /**
   * FR-MN-20: read_state:updated(채널 ACK) 의 서버 시각만 기록(워크스페이스 합계는
   * 단일 채널 ACK 로 정확히 알 수 없으므로 카운트는 건드리지 않고 lastAckedAt 만
   * 전진). 이후 도착하는 ACK-이전 시각의 badge_update 를 stale 로 거르는 게 목적이다
   * (정확한 합계는 서버 badge_update 또는 GET /me/notification-badges 재동기화가 채운다).
   *
   * S47 fix-forward (BLOCKER-2): serverTimestamp(서버가 emit 한 ISO 시각)를 받아
   * **서버 시계** 로 lastAckedAt 을 저장한다(교차시계 비교 제거).
   */
  markAcked: (workspaceId: string, serverTimestamp: string) => void;
  /**
   * S69 (FR-W23): unread_count:increment(workspaceId 포함) 낙관 갱신. 서버는 이 이벤트를
   * **멘션이 도착한** 워크스페이스의 user 룸으로만 emit 한다(mention 전용 이벤트 —
   * outbox-to-ws.subscriber). 따라서 unreadCount 뿐 아니라 **mentionCount 도 += delta**
   * 로 낙관 갱신해 멘션 빨간 배지가 즉시 반영되게 한다. 직후 도착하는 서버 진실값
   * (applyServerUpdate / replaceAll)이 last-write-wins 로 교정한다. 두 카운트 모두
   * 0 미만으로 내려가지 않는다(음수 delta clamp).
   */
  applyOptimisticIncrement: (workspaceId: string, delta: number) => void;
  /**
   * S69 (FR-W20): connection:ready 의 allWorkspaceMentionCounts 소비. 가입한 모든
   * 워크스페이스의 멘션 카운트를 첫 페인트부터 채운다(비활성 워크스페이스 배지 복원).
   * unreadCount/lastAckedAt 는 보존하고 mentionCount 만 세팅한다(멘션 카운트만 신뢰).
   */
  applyConnectionMentionCounts: (
    counts: Array<{ workspaceId: string; mentionCount: number }>,
  ) => void;
  /** FR-MN-20: GET /me/notification-badges 결과로 전체 교체(재동기화). */
  replaceAll: (
    workspaces: Array<{ workspaceId: string; mentionCount: number; unreadCount: number }>,
  ) => void;
  /** 글로벌 합계(title badge 용) — 모든 워크스페이스 unread 합. */
  totalUnread: () => number;
  /** 글로벌 멘션 합계(favicon 숫자 배지 용). */
  totalMention: () => number;
  reset: () => void;
}

const EMPTY: BadgeEntry = {
  mentionCount: 0,
  unreadCount: 0,
  lastServerTs: 0,
  lastAckedAt: 0,
};

function parseTs(iso: string): number {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
}

export const useBadgeStore = create<BadgeStoreState>((set, get) => ({
  byWorkspace: {},

  applyServerUpdate: ({ workspaceId, mentionCount, unreadCount, serverTimestamp }) =>
    set((s) => {
      const prev = s.byWorkspace[workspaceId] ?? EMPTY;
      const ts = parseTs(serverTimestamp);
      // ACK 우선: ACK 이후 시각 기준으로 더 이른 badge_update 는 stale → 무시. 같은
      // 서버 시계끼리 비교하므로(BLOCKER-2) 서버 지연이 정당한 update 를 폐기하지 않는다.
      if (prev.lastAckedAt > 0 && ts < prev.lastAckedAt) return s;
      // last-write-wins: 더 과거의 badge_update 도 무시(out-of-order WS).
      if (ts < prev.lastServerTs) return s;
      return {
        byWorkspace: {
          ...s.byWorkspace,
          [workspaceId]: { ...prev, mentionCount, unreadCount, lastServerTs: ts },
        },
      };
    }),

  markAcked: (workspaceId, serverTimestamp) =>
    set((s) => {
      const prev = s.byWorkspace[workspaceId] ?? EMPTY;
      const ts = parseTs(serverTimestamp);
      // 서버 시각이 파싱 불가(0)면 ACK-우선 가드를 깨뜨릴 수 있으니 갱신하지 않는다.
      if (ts <= 0) return s;
      // 더 이른 ACK 가 뒤늦게 도착해도 lastAckedAt 은 後進하지 않는다(monotonic).
      if (ts <= prev.lastAckedAt) return s;
      return {
        byWorkspace: {
          ...s.byWorkspace,
          [workspaceId]: { ...prev, lastAckedAt: ts },
        },
      };
    }),

  applyOptimisticIncrement: (workspaceId, delta) =>
    set((s) => {
      if (delta === 0) return s;
      const prev = s.byWorkspace[workspaceId] ?? EMPTY;
      const nextUnread = Math.max(0, prev.unreadCount + delta);
      // unread_count:increment 는 멘션 전용 이벤트라 mentionCount 도 함께 +delta 한다
      // (멘션 빨간 배지 즉시 반영). 둘 다 0 미만으로 내려가지 않는다.
      const nextMention = Math.max(0, prev.mentionCount + delta);
      return {
        byWorkspace: {
          ...s.byWorkspace,
          [workspaceId]: { ...prev, unreadCount: nextUnread, mentionCount: nextMention },
        },
      };
    }),

  applyConnectionMentionCounts: (counts) =>
    set((s) => {
      const next = { ...s.byWorkspace };
      for (const c of counts) {
        const prev = next[c.workspaceId] ?? EMPTY;
        next[c.workspaceId] = { ...prev, mentionCount: c.mentionCount };
      }
      return { byWorkspace: next };
    }),

  replaceAll: (workspaces) =>
    set((s) => {
      const next: Record<string, BadgeEntry> = {};
      for (const w of workspaces) {
        const prev = s.byWorkspace[w.workspaceId] ?? EMPTY;
        next[w.workspaceId] = {
          mentionCount: w.mentionCount,
          unreadCount: w.unreadCount,
          // 재동기화는 서버 진실값이라 lastServerTs 를 지금으로 올려 이후 stale WS 를
          // 자연히 거른다. lastAckedAt 은 보존(ACK 우선 가드 유지).
          lastServerTs: Date.now(),
          lastAckedAt: prev.lastAckedAt,
        };
      }
      return { byWorkspace: next };
    }),

  totalUnread: () => Object.values(get().byWorkspace).reduce((acc, e) => acc + e.unreadCount, 0),

  totalMention: () => Object.values(get().byWorkspace).reduce((acc, e) => acc + e.mentionCount, 0),

  reset: () => set({ byWorkspace: {} }),
}));
