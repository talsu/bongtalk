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
      // S82a fix-forward (reviewer LOW-2): Cmd+K 퀵스위처와 별개로 Cmd+Shift+K 가
      // 명령 팰릿(액션 실행)으로 재바인딩됐음을 치트시트에 명시한다.
      {
        combo: 'Ctrl/Cmd + Shift + K',
        desc: '명령 팰릿(액션 실행)',
        mnemonic: 'Shift+K = 액션(Kommand)',
      },
      { combo: 'Ctrl/Cmd + /', desc: '단축키 오버레이 / 검색 포커스', mnemonic: '/ = 검색 슬래시' },
      { combo: 'Alt + ↑ / ↓', desc: '이전 / 다음 채널' },
      // S82b fix-forward (reviewer LOW-1 / a11y MODERATE): 신규 단축키 2종 노출(발견성).
      { combo: 'Alt + Shift + ↑ / ↓', desc: '이전 / 다음 미읽 채널' },
      { combo: 'Ctrl/Cmd + N', desc: '새 DM 시작', mnemonic: 'N = New DM' },
      { combo: 'Ctrl/Cmd + Shift + A', desc: '다음 워크스페이스', mnemonic: 'A = Auto-cycle' },
      { combo: '?', desc: '이 도움말 열기', mnemonic: '? = 물음표 = 도움말' },
      // S78 reviewer N1: Esc 는 맥락에 따라 동작이 다르다. 종전 'Escape'(닫기)와
      // 'Esc'(읽음 표시)가 별개 키처럼 읽혀 혼란스러웠다 — 표기를 'Esc' 로
      // 통일하고 각 행에 적용 맥락을 명시해 같은 키의 맥락별 동작임을 드러낸다.
      { combo: 'Esc', desc: '열린 modal / dropdown 이 있을 때: 닫기' },
      { combo: 'Esc', desc: '입력 포커스가 없을 때: 현재 채널 읽음 표시' },
      { combo: 'Shift + Esc', desc: '워크스페이스 전체 읽음 표시' },
    ],
  },
  {
    title: '메시지 포맷',
    entries: [
      { combo: 'Enter', desc: '메시지 전송 (composer)' },
      { combo: 'Shift + Enter', desc: '줄바꿈 (composer)' },
      { combo: 'Ctrl/Cmd + B', desc: '볼드', mnemonic: 'B = Bold' },
      { combo: 'Ctrl/Cmd + I', desc: '이탤릭', mnemonic: 'I = Italic' },
      { combo: 'Ctrl/Cmd + Shift + X', desc: '취소선' },
      { combo: 'Ctrl/Cmd + Shift + C', desc: '인라인 코드' },
      { combo: 'Ctrl/Cmd + Shift + Enter', desc: '코드 블록' },
      { combo: '↑', desc: '빈 입력창에서: 최근 내 메시지 편집' },
    ],
  },
  {
    title: '메시지 액션',
    entries: [
      // S83b (FR-KS-08): 메시지에 hover 또는 키보드 포커스 시 단일 키로 동작한다
      // (E/Delete 는 내 메시지만). pending 해제 + A(북마크)·M(리마인더) 추가.
      { combo: 'E', desc: '내 메시지 편집', mnemonic: 'E = Edit' },
      { combo: 'Delete', desc: '내 메시지 삭제 다이얼로그' },
      { combo: 'R', desc: '이모지 반응 피커', mnemonic: 'R = React' },
      { combo: 'T', desc: '스레드 열기', mnemonic: 'T = Thread' },
      { combo: 'P', desc: '핀 / 언핀', mnemonic: 'P = Pin' },
      { combo: 'A', desc: '북마크(저장) 토글', mnemonic: 'A = Add to saved' },
      { combo: 'M', desc: '리마인더 설정', mnemonic: 'M = reMind' },
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
      {CATEGORIES.map((cat, ci) => {
        // S78 reviewer FF5 (a11y MAJOR): 각 섹션을 제목과 명시적으로 연결한다.
        // heading id 를 section aria-labelledby 가 가리켜, SR 이 항목 그룹의
        // 맥락(어느 카테고리인지)을 그룹 단위로 안내하게 한다.
        const headingId = `shortcut-cat-${ci}`;
        return (
          <section key={cat.title} aria-labelledby={headingId} className="mb-[var(--s-4)]">
            <h3
              id={headingId}
              className="text-[length:var(--fs-12)] font-medium uppercase tracking-wide mb-[var(--s-2)]"
              style={{ color: 'var(--text-secondary)' }}
            >
              {cat.title}
            </h3>
            <ul>
              {cat.entries.map((s, ei) => (
                <li
                  // combo 가 맥락별로 중복(예: Esc 2행)될 수 있어 index 로 키를 잡는다.
                  key={`${ci}-${ei}`}
                  className="flex items-start justify-between py-[var(--s-2)] text-[length:var(--fs-14)]"
                  style={{ borderBottom: '1px solid var(--divider)' }}
                >
                  <div className="flex flex-col">
                    {/* S83a 사후 리뷰(ui-designer LOW-1): 바레 `text-text` 는 무효 Tailwind
                        키라 `text-foreground`(tailwind.config foreground=var(--text))로 교정. */}
                    <span className="text-foreground">
                      {s.desc}
                      {s.pending && (
                        <>
                          {/* FF5 (a11y MAJOR): 시각 뱃지는 aria-hidden 으로 중복
                              낭독을 막고, "(준비 중)" 맥락은 sr-only 로 SR 에
                              전달해 미배선 단축키임을 알린다. */}
                          <span
                            aria-hidden="true"
                            className="ml-[var(--s-2)] text-[length:var(--fs-11)]"
                            style={{ color: 'var(--text-secondary)' }}
                          >
                            (준비 중)
                          </span>
                          <span className="sr-only">— 준비 중인 단축키입니다</span>
                        </>
                      )}
                    </span>
                    {s.mnemonic && (
                      <span
                        className="text-[length:var(--fs-12)] mt-[var(--s-1)]"
                        style={{ color: 'var(--text-secondary)' }}
                      >
                        {s.mnemonic}
                      </span>
                    )}
                  </div>
                  {/* MEDIUM: raw px(inline border/padding/background)을 제거하고
                      DS 키캡 클래스 `.qf-kbd` 에 위임한다. 레이아웃(축소 방지·
                      왼쪽 간격)만 spacing 토큰으로 남긴다. */}
                  <kbd className="qf-kbd shrink-0 ml-[var(--s-3)]">{s.combo}</kbd>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </Dialog>
  );
}
