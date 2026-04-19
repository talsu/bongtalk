import { create } from 'zustand';

type UIState = {
  /** Member list visible on the right-hand column (desktop defaults to open). */
  memberListOpen: boolean;
  toggleMemberList: () => void;
  setMemberListOpen: (v: boolean) => void;

  /** Which modal (if any) is currently showing. Plain enum — no deep state. */
  openModal: 'command-palette' | 'shortcut-help' | 'settings' | null;
  setOpenModal: (m: UIState['openModal']) => void;

  /** Workspace-settings overlay path. Shell renders the overlay based on this. */
  workspaceSettingsFor: string | null;
  openWorkspaceSettings: (wsId: string) => void;
  closeWorkspaceSettings: () => void;
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
}));
