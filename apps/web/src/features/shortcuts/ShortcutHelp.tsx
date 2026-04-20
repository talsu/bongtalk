import { Dialog } from '../../design-system/primitives';
import { useUI } from '../../stores/ui-store';

const SHORTCUTS: Array<{ combo: string; desc: string }> = [
  { combo: 'Ctrl/Cmd + K', desc: '빠른 이동 팔레트' },
  { combo: 'Ctrl/Cmd + /', desc: '메시지 검색' },
  { combo: '?', desc: '이 도움말 열기' },
  { combo: 'Alt + ↑ / ↓', desc: '이전/다음 채널' },
  { combo: 'Ctrl/Cmd + Shift + A', desc: '다음 워크스페이스' },
  { combo: 'Escape', desc: '오버레이 닫기' },
  { combo: 'Enter', desc: '메시지 전송 (composer)' },
  { combo: 'Shift + Enter', desc: '줄바꿈 (composer)' },
  { combo: 'Shift + Esc', desc: '읽음 표시 (예정)' },
];

export function ShortcutHelp(): JSX.Element | null {
  const openModal = useUI((s) => s.openModal);
  const setOpenModal = useUI((s) => s.setOpenModal);
  const open = openModal === 'shortcut-help';
  if (!open) return null;
  return (
    <Dialog
      open
      onOpenChange={(v) => setOpenModal(v ? 'shortcut-help' : null)}
      title="단축키"
      description="Discord와 유사한 기본 키맵"
    >
      <ul>
        {SHORTCUTS.map((s) => (
          <li
            key={s.combo}
            className="flex items-center justify-between py-[var(--s-3)] text-[length:var(--fs-14)]"
            style={{ borderBottom: '1px solid var(--divider)' }}
          >
            <span className="text-text">{s.desc}</span>
            <kbd
              className="qf-menu__kbd"
              style={{
                border: '1px solid var(--border)',
                borderRadius: 'var(--r-xs)',
                padding: '2px 6px',
                background: 'var(--bg-panel)',
              }}
            >
              {s.combo}
            </kbd>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
