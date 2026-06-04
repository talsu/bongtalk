import { create } from 'zustand';

type UIState = {
  /** Member list visible on the right-hand column (desktop defaults to open). */
  memberListOpen: boolean;
  toggleMemberList: () => void;
  setMemberListOpen: (v: boolean) => void;

  /** Which modal (if any) is currently showing. Plain enum — no deep state. */
  openModal: 'command-palette' | 'shortcut-help' | 'settings' | 'search' | 'feedback' | null;
  setOpenModal: (m: UIState['openModal']) => void;

  /** Workspace-settings overlay path. Shell renders the overlay based on this. */
  workspaceSettingsFor: string | null;
  openWorkspaceSettings: (wsId: string) => void;
  closeWorkspaceSettings: () => void;

  /**
   * Channel id currently mounted in MessageColumn. Used by the realtime
   * dispatcher to skip unread-count bumps for messages that arrive on
   * the channel the user is actively viewing. Task-010 reviewer
   * finding-1 fix.
   */
  activeChannelId: string | null;
  setActiveChannelId: (chId: string | null) => void;

  /**
   * S30 (FR-S03): 검색 결과 패널의 활성 쿼리. null 이면 패널 닫힘. 비-null 이면
   * 우측 패널(멤버 목록)을 대체해 슬라이드인 결과 패널을 띄운다. Enter 시
   * SearchInput 이 설정하고, 닫기/채널 전환이 null 로 되돌린다.
   */
  searchPanelQuery: string | null;
  openSearchPanel: (_q: string) => void;
  closeSearchPanel: () => void;

  /**
   * S47 (FR-MN-13): Activity Inbox 패널 토글. true 면 우측 슬롯을 Inbox 패널
   * (role="complementary")로 대체한다. 헤더 알림 벨/단축키가 토글한다.
   */
  activityInboxOpen: boolean;
  toggleActivityInbox: () => void;
  setActivityInboxOpen: (v: boolean) => void;

  /**
   * S50 (D10 · FR-PS-03): 채널 핀 슬라이드인 패널 토글. true 면 MessageColumn 우측에
   * PinPanel 을 붙인다. 채널 헤더 핀 아이콘이 토글한다.
   */
  pinPanelOpen: boolean;
  togglePinPanel: () => void;
  setPinPanelOpen: (v: boolean) => void;

  /**
   * S69 (D13 / FR-W10 · Fork C): 멤버 디렉터리 오버레이 토글. 설정(ADMIN 게이트) 밖의
   * 멤버-접근 진입점이라 **모든 멤버**가 채널 헤더 '멤버' 버튼으로 연다(열람은 전원,
   * 관리 액션만 권한 게이트). true 면 우측 슬롯을 디렉터리 패널로 대체한다.
   */
  memberDirectoryOpen: boolean;
  toggleMemberDirectory: () => void;
  setMemberDirectoryOpen: (v: boolean) => void;
};

export const useUI = create<UIState>((set) => ({
  memberListOpen: true,
  toggleMemberList: () => set((s) => ({ memberListOpen: !s.memberListOpen })),
  setMemberListOpen: (v) => set({ memberListOpen: v }),

  openModal: null,
  setOpenModal: (m) => set({ openModal: m }),

  workspaceSettingsFor: null,
  openWorkspaceSettings: (wsId) => set({ workspaceSettingsFor: wsId }),
  closeWorkspaceSettings: () => set({ workspaceSettingsFor: null }),

  activeChannelId: null,
  setActiveChannelId: (chId) => set({ activeChannelId: chId }),

  searchPanelQuery: null,
  openSearchPanel: (q) => set({ searchPanelQuery: q }),
  closeSearchPanel: () => set({ searchPanelQuery: null }),

  activityInboxOpen: false,
  toggleActivityInbox: () => set((s) => ({ activityInboxOpen: !s.activityInboxOpen })),
  setActivityInboxOpen: (v) => set({ activityInboxOpen: v }),

  pinPanelOpen: false,
  togglePinPanel: () => set((s) => ({ pinPanelOpen: !s.pinPanelOpen })),
  setPinPanelOpen: (v) => set({ pinPanelOpen: v }),

  memberDirectoryOpen: false,
  // S69 fix-forward (a11y H-01): 디렉터리를 열 때 검색/inbox 패널을 **명시적으로 닫아**
  // 우측 슬롯의 우선순위 가림(stacking) 대신 단일 패널만 활성이게 한다(상호배타). 닫을
  // 때는 다른 패널 상태를 건드리지 않는다.
  toggleMemberDirectory: () =>
    set((s) =>
      s.memberDirectoryOpen
        ? { memberDirectoryOpen: false }
        : { memberDirectoryOpen: true, searchPanelQuery: null, activityInboxOpen: false },
    ),
  setMemberDirectoryOpen: (v) =>
    set(() =>
      v
        ? { memberDirectoryOpen: true, searchPanelQuery: null, activityInboxOpen: false }
        : { memberDirectoryOpen: false },
    ),
}));
