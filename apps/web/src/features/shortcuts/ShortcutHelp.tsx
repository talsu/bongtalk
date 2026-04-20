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
      <ul className="divide-y divide-border-subtle">
        {SHORTCUTS.map((s) => (
          <li key={s.combo} className="flex items-center justify-between py-2 text-sm">
            <span className="text-foreground">{s.desc}</span>
            <kbd className="rounded border border-border-subtle bg-bg-subtle px-2 py-0.5 font-mono text-[11px] text-text-muted">
              {s.combo}
            </kbd>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
