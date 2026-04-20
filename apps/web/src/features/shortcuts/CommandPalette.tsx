import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useUI } from '../../stores/ui-store';
import { useMyWorkspaces } from '../workspaces/useWorkspaces';
import { useChannelList } from '../channels/useChannels';
import { Dialog, Input } from '../../design-system/primitives';

type Action = {
  label: string;
  hint?: string;
  run: () => void;
};

/**
 * Ctrl+K palette. Single input + filtered action list. Scope is bounded —
 * we only populate from the current user's workspaces + current workspace's
 * channels. Arbitrary-text search comes later when we have a real search
 * backend (TODO task-025).
 */
export function CommandPalette(): JSX.Element | null {
  const openModal = useUI((s) => s.openModal);
  const setOpenModal = useUI((s) => s.setOpenModal);
  const navigate = useNavigate();
  const { slug } = useParams<{ slug: string }>();
  const { data: mine } = useMyWorkspaces();
  const { data: channels } = useChannelList(mine?.workspaces.find((w) => w.slug === slug)?.id);
  const [query, setQuery] = useState('');
  const [focusIdx, setFocusIdx] = useState(0);

  const actions = useMemo<Action[]>(() => {
    const list: Action[] = [];
    for (const ws of mine?.workspaces ?? []) {
      list.push({
        label: `워크스페이스 · ${ws.name}`,
        hint: `@${ws.slug}`,
        run: () => {
          navigate(`/w/${ws.slug}`);
          setOpenModal(null);
        },
      });
    }
    if (slug && channels) {
      const allChannels = [
        ...channels.uncategorized,
        ...channels.categories.flatMap((c) => c.channels),
      ];
      for (const ch of allChannels) {
        list.push({
          label: `# ${ch.name}`,
          hint: '현재 워크스페이스',
          run: () => {
            navigate(`/w/${slug}/${ch.name}`);
            setOpenModal(null);
          },
        });
      }
    }
    return list;
  }, [mine, channels, slug, navigate, setOpenModal]);

  const filtered = useMemo(() => {
    if (!query) return actions.slice(0, 20);
    const q = query.toLowerCase();
    return actions.filter((a) => a.label.toLowerCase().includes(q)).slice(0, 20);
  }, [actions, query]);

  const isOpen = openModal === 'command-palette';
  if (!isOpen) return null;

  // Wiring the WAI-ARIA "editable combobox with listbox popup" pattern:
  // the input carries role=combobox, points at the listbox via
  // aria-controls, announces open state via aria-expanded, and
  // aria-activedescendant points at the currently-focused option id.
  // The Dialog itself keeps focus inside so Escape / outside-click
  // close it — no separate blur handler needed.
  const listboxId = 'command-palette-listbox';
  const optionId = (i: number): string => `command-palette-option-${i}`;
  const activeId = filtered.length > 0 ? optionId(focusIdx) : undefined;

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(v) => setOpenModal(v ? 'command-palette' : null)}
      title="빠른 이동"
      className="max-w-lg"
    >
      <Input
        data-testid="palette-input"
        autoFocus
        placeholder="채널 또는 워크스페이스 이름"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={true}
        aria-controls={listboxId}
        aria-activedescendant={activeId}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setFocusIdx(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setFocusIdx((i) => Math.min(i + 1, filtered.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setFocusIdx((i) => Math.max(i - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            filtered[focusIdx]?.run();
          }
        }}
      />
      <ul id={listboxId} role="listbox" className="mt-[var(--s-4)] max-h-72 overflow-y-auto">
        {filtered.length === 0 ? (
          <li className="qf-empty !py-[var(--s-7)]">
            <div className="qf-empty__body">결과 없음</div>
          </li>
        ) : null}
        {filtered.map((a, i) => (
          <li
            key={a.label}
            id={optionId(i)}
            role="option"
            aria-selected={i === focusIdx}
            data-testid={`palette-item-${i}`}
            onMouseEnter={() => setFocusIdx(i)}
            onClick={() => a.run()}
            className="qf-menu__item justify-between"
            style={{
              background: i === focusIdx ? 'var(--bg-selected)' : 'transparent',
              color: i === focusIdx ? 'var(--text-strong)' : 'var(--text-secondary)',
            }}
          >
            <span>{a.label}</span>
            {a.hint ? <span className="qf-menu__kbd">{a.hint}</span> : null}
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
