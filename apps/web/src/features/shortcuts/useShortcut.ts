import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useUI } from '../../stores/ui-store';
import { useMyWorkspaces } from '../workspaces/useWorkspaces';
import { useChannelList } from '../channels/useChannels';

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
  const { data: mine } = useMyWorkspaces();
  const { data: channels } = useChannelList(mine?.workspaces.find((w) => w.slug === slug)?.id);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const inputActive = inInput(e.target);

      // Escape: always close overlays (works even in inputs so you can bail
      // out of a dialog).
      if (e.key === 'Escape' && openModal) {
        setOpenModal(null);
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
  }, [navigate, slug, channelName, channels, mine, setOpenModal, openModal]);
}
