import { Dialog } from '../../design-system/primitives';
import { useUI } from '../../stores/ui-store';

/**
 * task-046 iter5 (L1/L2/L3): 카테고리별 단축키 cheat sheet.
 *
 * 045 까지의 평면 list 를 카테고리 단위로 묶어 학습 부담 감소.
 * 각 항목의 한국어 mnemonic (예: "K = 빠른 이동", "/ = 검색") 을 명시.
 *
 * S78 (PRD parity): PRD D15 의 3-카테고리(내비게이션 / 메시지 포맷 / 메시지
 * 액션) 구조로 확장한다. 이번 슬라이스는 **치트시트 표시만** 한다 — 포맷
 * 단축키(Ctrl+B/I…)와 메시지 액션 단축키(E/Delete/R/T…)의 실제 동작 배선은
 * 각각 S83 / S82 에서 구현하므로, 아직 미배선인 항목은 `pending: true` 로
 * "준비 중" 뱃지를 단다(거짓 약속 방지). 이미 동작하는 항목(Enter, Ctrl/Cmd+K,
 * Alt+↑/↓, Ctrl/Cmd+/, Escape 등)은 뱃지 없이 그대로 노출한다.
 */

interface ShortcutEntry {
  combo: string;
  desc: string;
  /** 한국어 mnemonic — 단축키와 동작의 연결 단서 */
  mnemonic?: string;
  /** 아직 동작이 배선되지 않은 단축키(표시만). S82/S83 에서 실동작 도입. */
  pending?: boolean;
}

interface ShortcutCategory {
  title: string;
  entries: ShortcutEntry[];
}

const CATEGORIES: ShortcutCategory[] = [
  {
    title: '내비게이션',
    entries: [
      { combo: 'Ctrl/Cmd + K', desc: '퀵스위처(빠른 이동)', mnemonic: 'K = 점프(K-jump)' },
      { combo: 'Ctrl/Cmd + /', desc: '단축키 오버레이 / 검색 포커스', mnemonic: '/ = 검색 슬래시' },
      { combo: 'Alt + ↑ / ↓', desc: '이전 / 다음 채널' },
      { combo: 'Ctrl/Cmd + Shift + A', desc: '다음 워크스페이스', mnemonic: 'A = Auto-cycle' },
      { combo: '?', desc: '이 도움말 열기', mnemonic: '? = 물음표 = 도움말' },
      { combo: 'Escape', desc: '열린 modal / dropdown 닫기' },
      { combo: 'Esc', desc: '현재 채널 읽음 표시' },
      { combo: 'Shift + Esc', desc: '워크스페이스 전체 읽음 표시' },
    ],
  },
  {
    title: '메시지 포맷',
    entries: [
      { combo: 'Enter', desc: '메시지 전송 (composer)' },
      { combo: 'Shift + Enter', desc: '줄바꿈 (composer)' },
      { combo: 'Ctrl/Cmd + B', desc: '볼드', mnemonic: 'B = Bold', pending: true },
      { combo: 'Ctrl/Cmd + I', desc: '이탤릭', mnemonic: 'I = Italic', pending: true },
      { combo: 'Ctrl + Shift + X', desc: '취소선', pending: true },
      { combo: 'Ctrl + Shift + C', desc: '인라인 코드', pending: true },
    ],
  },
  {
    title: '메시지 액션',
    entries: [
      { combo: 'E', desc: '내 메시지 편집', mnemonic: 'E = Edit', pending: true },
      { combo: 'Delete', desc: '내 메시지 삭제 다이얼로그', pending: true },
      { combo: 'R', desc: '이모지 반응 피커', mnemonic: 'R = React', pending: true },
      { combo: 'T / →', desc: '스레드 열기', mnemonic: 'T = Thread', pending: true },
      { combo: 'P', desc: '핀 / 언핀', mnemonic: 'P = Pin', pending: true },
    ],
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
                  <span className="text-text">
                    {s.desc}
                    {s.pending && (
                      <span
                        className="ml-[var(--s-2)] text-[length:var(--fs-11)]"
                        style={{ color: 'var(--text-secondary)' }}
                      >
                        (준비 중)
                      </span>
                    )}
                  </span>
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
