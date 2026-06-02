/**
 * THE single source of React Query cache keys. Every useQuery / useMutation
 * / setQueryData / invalidateQueries call in the app flows through this
 * file so that:
 *
 *   1. key drift is impossible — a channel list is the same tuple everywhere
 *   2. the realtime dispatcher can derive the exact key from an event
 *   3. the ESLint rule `no-restricted-syntax` bans hard-coded string arrays
 */
export const qk = {
  auth: {
    me: () => ['auth', 'me'] as const,
  },
  workspaces: {
    list: () => ['workspaces'] as const,
    detail: (wsId: string) => ['workspaces', wsId] as const,
    members: (wsId: string) => ['workspaces', wsId, 'members'] as const,
    invites: (wsId: string) => ['workspaces', wsId, 'invites'] as const,
  },
  channels: {
    list: (wsId: string) => ['workspaces', wsId, 'channels'] as const,
    detail: (chId: string) => ['channels', chId] as const,
    unreadSummary: (wsId: string) => ['workspaces', wsId, 'unread-summary'] as const,
  },
  me: {
    unreadTotals: () => ['me', 'unread-totals'] as const,
    notificationPreferences: () => ['me', 'notification-preferences'] as const,
    // S46 (FR-MN-05): 글로벌 알림 설정(NotifLevel + keywords + dnd).
    globalNotificationSettings: () => ['me', 'settings', 'notifications'] as const,
    // S46 (FR-MN-06): 서버별 알림 오버라이드.
    serverNotificationPref: (wsId: string) =>
      ['workspaces', wsId, 'notification-preferences'] as const,
    // S46 (FR-MN-07): 채널별 알림 오버라이드.
    channelNotificationPref: (wsId: string, chId: string) =>
      ['workspaces', wsId, 'channels', chId, 'notification-preferences'] as const,
    // task-047 iter4 (M3): profile (bio + links + customStatus)
    profile: () => ['me', 'profile'] as const,
    // S28 (FR-P04/P17): 구조화 커스텀 상태(text + emoji + expiresAt).
    customStatus: () => ['me', 'custom-status'] as const,
    // S28 (FR-P06): DND 주간 스케줄 + 평가된 preference.
    dndSchedule: () => ['me', 'dnd-schedule'] as const,
    // S38 (FR-TH-09): 내 구독 스레드 목록(Threads 탭).
    threads: () => ['me', 'threads'] as const,
  },
  messages: {
    list: (wsId: string, chId: string) => ['messages', wsId, chId] as const,
    detail: (msgId: string) => ['messages', msgId] as const,
    // Task-014-C: thread panel cache is keyed by root id alone because
    // the thread endpoint derives channel + workspace from the id.
    // Keeps the dispatcher branch simple (one key per WS event).
    thread: (rootId: string) => ['messages', 'thread', rootId] as const,
    // S35 (FR-TH-20b): 열린 모든 스레드 캐시를 prefix 로 매칭하는 키. 답글/루트
    // 삭제 동기화에서 parentMessageId 를 모를 때(message.deleted 이벤트는 그
    // 필드를 싣지 않음) getQueriesData 로 일치하는 스레드 캐시를 찾는 데 쓴다.
    threadRoot: () => ['messages', 'thread'] as const,
    // S37 (FR-MSG-08): 메시지 편집 이력 팝오버 캐시. msgId 단위로 키잉하며
    // 팝오버가 열릴 때만(enabled) fetch 합니다. 보안: wsId/channelId 를 키에
    // 포함해 스코프를 명시하고(역할 강등 후 누출 창 축소 + 범위 격리), gcTime:0
    // 으로 팝오버가 닫히면 즉시 파기합니다(useEditHistory 참조).
    editHistory: (wsId: string, chId: string, msgId: string) =>
      ['messages', wsId, chId, msgId, 'history'] as const,
    // S37 fix-forward (BLOCKER-1): permalink(`?msg=`) 점프 전용 one-shot
    // around 캐시. 메인 list 캐시(`messages.list`)와 분리해, 점프 대상이
    // window 밖(캐시된 채널)에 있어도 실제 around-load 가 발화되도록 한다.
    // jumpMessageId 단위로 키잉 — 동일 대상 재점프는 캐시 hit, 새 대상은 새
    // fetch. gcTime:0 으로 소비 후 파기(메인 캐시 오염 0).
    jumpAround: (wsId: string, chId: string, jumpMessageId: string) =>
      ['messages', wsId, chId, jumpMessageId, 'jump-around'] as const,
  },
  reactions: {
    // S40 (FR-RE05): 한 이모지의 전체 reactor 목록(무한 스크롤 모달). msgId+emoji
    // 단위로 키잉한다. `messages` prefix 와 분리된 `reactions` prefix 라 dispatcher 의
    // 메시지 목록 3-tuple 스캔(`['messages', wsId, chId]`)과 절대 겹치지 않는다.
    users: (msgId: string, emoji: string) => ['reactions', 'users', msgId, emoji] as const,
  },
  presence: {
    workspace: (wsId: string) => ['presence', wsId] as const,
    // S26 (FR-P16): per-user precise presence pushed by `presence:update`
    // (subscription fan-out). Keyed by userId so a DM peer / viewport-watched
    // member's status can be read independently of any workspace snapshot.
    user: (userId: string) => ['presence', 'user', userId] as const,
    // task-041 A-3: prefix-only key for DM presence aggregation.
    // useDmPresence calls `qc.getQueriesData({ queryKey: qk.presence.all() })`
    // to walk every per-workspace presence snapshot in cache.
    all: () => ['presence'] as const,
  },
} as const;
