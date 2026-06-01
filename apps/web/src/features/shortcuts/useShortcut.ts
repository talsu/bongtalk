import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useUI } from '../../stores/ui-store';
import { useMyWorkspaces } from '../workspaces/useWorkspaces';
import { useChannelList } from '../channels/useChannels';
import { useMarkAllRead } from '../channels/useUnread';
import { classifyReadShortcut } from './readShortcut';
import { searchPrefillQuery } from './searchPrefill';
import { announce } from '../../lib/a11y-announce';

type Combo = {
  key: string;
  ctrlOrMeta?: boolean;
  shift?: boolean;
  alt?: boolean;
};

function matches(e: KeyboardEvent, c: Combo): boolean {
  const wantCtrl = c.ctrlOrMeta ?? false;
  const pressedCtrl = e.ctrlKey || e.metaKey;
  return (
    e.key.toLowerCase() === c.key.toLowerCase() &&
    wantCtrl === pressedCtrl &&
    Boolean(c.shift) === e.shiftKey &&
    Boolean(c.alt) === e.altKey
  );
}

function inInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * App-level shortcuts. Bound ONCE on mount (inside Shell), so every route
 * inside the shell gets the same keymap without prop-drilling.
 * Shortcuts that must work inside an input (Escape to close overlays)
 * opt-in via the `force` flag on the match function.
 */
export function useGlobalShortcuts(): void {
  const navigate = useNavigate();
  const { slug, channelName } = useParams<{ slug: string; channelName?: string }>();
  const setOpenModal = useUI((s) => s.setOpenModal);
  const openModal = useUI((s) => s.openModal);
  // S31 (FR-S12): Ctrl/Cmd+F → 현재 채널 in: 프리필 검색 패널.
  const openSearchPanel = useUI((s) => s.openSearchPanel);
  const { data: mine } = useMyWorkspaces();
  const currentWorkspaceId = mine?.workspaces.find((w) => w.slug === slug)?.id;
  const { data: channels } = useChannelList(currentWorkspaceId);
  // S23 (FR-RS-11): Shift+Esc = 워크스페이스 전체 읽음. 현재 워크스페이스
  // scope 로 bulk read-all 을 발화한다.
  const markAllRead = useMarkAllRead(currentWorkspaceId);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const inputActive = inInput(e.target);

      // Escape: always close overlays (works even in inputs so you can bail
      // out of a dialog).
      if (e.key === 'Escape' && openModal) {
        setOpenModal(null);
        return;
      }

      // S23 (FR-RS-11): Esc=현재 채널 읽음 / Shift+Esc=전체 읽음. 모달이 위에서
      // 이미 처리됐고, 입력 필드 포커스 중에는 classify 가 none 을 돌려 기존 Esc
      // 동작(컴포저 자동완성 닫기/포커스 해제)을 무회귀로 둔다.
      //
      // S23 BLOCKER fix (이중 방어): EmojiPicker/ThreadPanel/SearchInput 같은
      // 오버레이가 Esc 를 소비하면 e.preventDefault()(+ stopPropagation)를
      // 호출한다. 그 오버레이의 window 리스너가 먼저 실행돼 defaultPrevented 가
      // 켜졌다면 read 단축키를 skip 해 채널이 강제 읽음 처리되지 않게 한다.
      if (e.defaultPrevented) return;
      const readAction = classifyReadShortcut(e, { inputActive, modalOpen: openModal !== null });
      if (readAction === 'mark-current') {
        e.preventDefault();
        // 현재 채널의 최신 메시지까지 읽음 — AckScheduler 를 보유한 MessageColumn 에
        // CustomEvent 로 위임한다(검색/컴포저 포커스와 동일한 dispatch 패턴).
        window.dispatchEvent(new CustomEvent('qufox.read.current'));
        announce('현재 채널을 읽음으로 표시했습니다');
        return;
      }
      if (readAction === 'mark-all') {
        e.preventDefault();
        if (currentWorkspaceId) {
          markAllRead.mutate();
          announce('워크스페이스의 모든 채널을 읽음으로 표시했습니다');
        }
        return;
      }

      if (inputActive) return;

      // Ctrl/Cmd + K → command palette
      if (matches(e, { key: 'k', ctrlOrMeta: true })) {
        e.preventDefault();
        setOpenModal(openModal === 'command-palette' ? null : 'command-palette');
        return;
      }

      // task-015-C: Ctrl/Cmd + / → focus the inline topbar search.
      // Help is `?` alone. Previously this opened a modal; the
      // search UX now lives in the topbar input with an inline
      // results dropdown, so we just focus the input.
      if (matches(e, { key: '/', ctrlOrMeta: true })) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('qufox.search.focus'));
        return;
      }

      // S31 (FR-S12 + reviewer NIT5/DM): Ctrl/Cmd + F → 현재 채널 로컬 검색.
      //  - 모달이 열려 있으면 가로채지 않는다(브라우저 기본 찾기 유지) — 모달
      //    위에서 단축키가 패널을 띄우면 맥락이 어긋난다.
      //  - in:#<채널> 프리필은 실제 텍스트성 채널일 때만 적합하다. DM/그룹 DM
      //    은 #채널 이름이 없으므로(in:#<userId> 는 부적합) 빈 패널을 연다.
      //  - 현재 채널이 없으면(워크스페이스 루트) 브라우저 기본 찾기를 둔다.
      if (matches(e, { key: 'f', ctrlOrMeta: true }) && channelName && !openModal) {
        const flat = channels
          ? [...channels.uncategorized, ...channels.categories.flatMap((c) => c.channels)]
          : [];
        const current = flat.find((c) => c.name === channelName);
        e.preventDefault();
        // 텍스트성 채널만 in:#name 프리필. DM/그룹 DM/미해결 채널은 빈 패널.
        openSearchPanel(searchPrefillQuery(channelName, current?.type));
        return;
      }

      // `?` (Shift+/ on US layout) → shortcut help. No Ctrl. In-input
      // guard above already blocks this inside textareas/inputs.
      if (e.key === '?') {
        e.preventDefault();
        setOpenModal(openModal === 'shortcut-help' ? null : 'shortcut-help');
        return;
      }

      // Alt + ↑/↓: previous/next channel in current workspace
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.altKey && slug && channels) {
        const flat = [...channels.uncategorized, ...channels.categories.flatMap((c) => c.channels)];
        if (flat.length === 0) return;
        const currentIdx = flat.findIndex((c) => c.name === channelName);
        const step = e.key === 'ArrowDown' ? 1 : -1;
        const nextIdx = currentIdx < 0 ? 0 : (currentIdx + step + flat.length) % flat.length;
        e.preventDefault();
        navigate(`/w/${slug}/${flat[nextIdx].name}`);
        return;
      }

      // Ctrl/Cmd + Shift + A: cycle workspaces
      if (
        matches(e, { key: 'a', ctrlOrMeta: true, shift: true }) &&
        mine &&
        mine.workspaces.length > 0
      ) {
        const list = mine.workspaces;
        const idx = list.findIndex((w) => w.slug === slug);
        const next = list[(idx + 1) % list.length];
        e.preventDefault();
        navigate(`/w/${next.slug}`);
        return;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    navigate,
    slug,
    channelName,
    channels,
    mine,
    setOpenModal,
    openModal,
    openSearchPanel,
    currentWorkspaceId,
    markAllRead,
  ]);
}
