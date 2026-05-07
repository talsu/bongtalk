import { Dialog } from '../../design-system/primitives';
import { useUI } from '../../stores/ui-store';

/**
 * task-046 iter5 (L1/L2/L3): 카테고리별 단축키 cheat sheet.
 *
 * 045 까지의 평면 list 를 카테고리 단위로 묶어 학습 부담 감소.
 * 각 항목의 한국어 mnemonic (예: "K = 빠른 이동", "/ = 검색") 을 명시.
 */

interface ShortcutEntry {
  combo: string;
  desc: string;
  /** 한국어 mnemonic — 단축키와 동작의 연결 단서 */
  mnemonic?: string;
}

interface ShortcutCategory {
  title: string;
  entries: ShortcutEntry[];
}

const CATEGORIES: ShortcutCategory[] = [
  {
    title: '탐색',
    entries: [
      { combo: 'Ctrl/Cmd + K', desc: '빠른 이동 팔레트', mnemonic: 'K = 점프(K-jump)' },
      { combo: 'Alt + ↑ / ↓', desc: '이전 / 다음 채널' },
      { combo: 'Ctrl/Cmd + Shift + A', desc: '다음 워크스페이스', mnemonic: 'A = Auto-cycle' },
    ],
  },
  {
    title: '검색 & 도움말',
    entries: [
      { combo: 'Ctrl/Cmd + /', desc: '메시지 검색 포커스', mnemonic: '/ = 검색 슬래시' },
      { combo: '?', desc: '이 도움말 열기', mnemonic: '? = 물음표 = 도움말' },
    ],
  },
  {
    title: '메시지',
    entries: [
      { combo: 'Enter', desc: '메시지 전송 (composer)' },
      { combo: 'Shift + Enter', desc: '줄바꿈 (composer)' },
      { combo: 'Shift + Esc', desc: '읽음 표시 (예정)' },
    ],
  },
  {
    title: '오버레이',
    entries: [{ combo: 'Escape', desc: '열린 modal / dropdown 닫기' }],
  },
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
      description="카테고리별 키맵 — `?` 키로 언제든 다시 열 수 있습니다."
    >
      {CATEGORIES.map((cat) => (
        <section key={cat.title} className="mb-[var(--s-4)]">
          <h3
            className="text-[length:var(--fs-12)] font-medium uppercase tracking-wide"
            style={{ color: 'var(--text-secondary)', marginBottom: 'var(--s-2)' }}
          >
            {cat.title}
          </h3>
          <ul>
            {cat.entries.map((s) => (
              <li
                key={s.combo}
                className="flex items-start justify-between py-[var(--s-2)] text-[length:var(--fs-14)]"
                style={{ borderBottom: '1px solid var(--divider)' }}
              >
                <div className="flex flex-col">
                  <span className="text-text">{s.desc}</span>
                  {s.mnemonic && (
                    <span
                      className="text-[length:var(--fs-12)]"
                      style={{ color: 'var(--text-secondary)', marginTop: '2px' }}
                    >
                      {s.mnemonic}
                    </span>
                  )}
                </div>
                <kbd
                  className="qf-menu__kbd"
                  style={{
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--r-xs)',
                    padding: '2px 6px',
                    background: 'var(--bg-panel)',
                    flexShrink: 0,
                    marginLeft: 'var(--s-3)',
                  }}
                >
                  {s.combo}
                </kbd>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </Dialog>
  );
}
