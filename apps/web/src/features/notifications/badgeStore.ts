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
 *  2. message:ack(read_state:updated) 응답의 unreadCount → applyAck. 즉시 갱신하고
 *     그 시각을 lastAckedAt 으로 기록해, 이후 도착하는 더 이른 badge_update 를 거른다.
 *  3. GET /me/notification-badges 재동기화 → replaceAll(전체 교체, 서버 진실값).
 *
 * 낙관적 +1(bumpOptimistic)은 지연 보상용이며, 서버값이 last-write-wins 로 덮는다.
 *
 * 시각 비교는 epoch ms 로 한다. badge_update 의 serverTimestamp(ISO) 는 파싱해
 * 비교하고, ACK 시각은 클라 Date.now() 를 쓴다(서버/클라 시계 차는 ACK-우선의 보수적
 * 근사 — ACK 직후 동일 채널의 낡은 badge_update 를 거르는 게 목적이라 충분하다).
 */
export interface BadgeEntry {
  mentionCount: number;
  unreadCount: number;
  /** 마지막으로 반영한 서버 badge_update 의 serverTimestamp(epoch ms). 없으면 0. */
  lastServerTs: number;
  /** 마지막 ACK 반영 시각(epoch ms). 이보다 이른 badge_update 는 stale 로 무시. */
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
  /** FR-MN-20: message:ack 응답 unreadCount 즉시 반영 + lastAckedAt 기록. */
  applyAck: (args: { workspaceId: string; unreadCount: number; mentionCount?: number }) => void;
  /**
   * FR-MN-20: per-channel ACK 의 시각만 기록(워크스페이스 합계는 단일 채널 ACK 로
   * 정확히 알 수 없으므로 카운트는 건드리지 않고 lastAckedAt 만 전진). 이후 도착하는
   * ACK-이전 시각의 badge_update 를 stale 로 거르는 게 목적이다(정확한 합계는 서버
   * badge_update 또는 GET /me/notification-badges 재동기화가 채운다).
   */
  markAcked: (workspaceId: string) => void;
  /** FR-MN-20: GET /me/notification-badges 결과로 전체 교체(재동기화). */
  replaceAll: (
    workspaces: Array<{ workspaceId: string; mentionCount: number; unreadCount: number }>,
  ) => void;
  /** FR-MN-14: 낙관적 +1(isMuted 확인은 호출부 책임 — 뮤트면 호출하지 않는다). */
  bumpOptimistic: (args: { workspaceId: string; mention: boolean }) => void;
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
      // ACK 우선: ACK 이후 시각 기준으로 더 이른 badge_update 는 stale → 무시.
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

  applyAck: ({ workspaceId, unreadCount, mentionCount }) =>
    set((s) => {
      const prev = s.byWorkspace[workspaceId] ?? EMPTY;
      return {
        byWorkspace: {
          ...s.byWorkspace,
          [workspaceId]: {
            ...prev,
            unreadCount,
            mentionCount: mentionCount ?? prev.mentionCount,
            lastAckedAt: Date.now(),
          },
        },
      };
    }),

  markAcked: (workspaceId) =>
    set((s) => {
      const prev = s.byWorkspace[workspaceId] ?? EMPTY;
      return {
        byWorkspace: {
          ...s.byWorkspace,
          [workspaceId]: { ...prev, lastAckedAt: Date.now() },
        },
      };
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

  bumpOptimistic: ({ workspaceId, mention }) =>
    set((s) => {
      const prev = s.byWorkspace[workspaceId] ?? EMPTY;
      return {
        byWorkspace: {
          ...s.byWorkspace,
          [workspaceId]: {
            ...prev,
            unreadCount: prev.unreadCount + 1,
            mentionCount: prev.mentionCount + (mention ? 1 : 0),
          },
        },
      };
    }),

  totalUnread: () => Object.values(get().byWorkspace).reduce((acc, e) => acc + e.unreadCount, 0),

  totalMention: () => Object.values(get().byWorkspace).reduce((acc, e) => acc + e.mentionCount, 0),

  reset: () => set({ byWorkspace: {} }),
}));
