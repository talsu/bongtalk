/**
 * S23 (FR-RS-11): Esc/Shift+Esc 읽음 단축키 분류 — 순수 로직.
 *
 * 정본(PRD): Esc = 현재 채널 읽음(ackRead 최신), Shift+Esc = 워크스페이스 전체
 * 읽음(bulk). monotonic 전진이라 충돌 없음(mark-as-unread 아님).
 *
 * 컴포저/입력 필드 포커스 중에는 둘 다 none — 기존 Esc 동작(자동완성 닫기/
 * 포커스 해제/편집 취소)이 우선이라 무회귀(FR-RS-11 컴포저 충돌 처리). 모달이
 * 열려 있으면 Esc 는 모달 닫기가 우선이므로 none.
 *
 * useGlobalShortcuts(hook)이 이 함수로 의도를 분류한 뒤 부수효과(dispatch/
 * mutate)를 수행한다. 순수 분류라 단위 테스트가 DOM 없이 가능하다.
 */
export type ReadShortcutAction = 'mark-current' | 'mark-all' | 'none';

export function classifyReadShortcut(
  e: Pick<KeyboardEvent, 'key' | 'shiftKey'>,
  ctx: { inputActive: boolean; modalOpen: boolean },
): ReadShortcutAction {
  if (e.key !== 'Escape') return 'none';
  // 입력 필드(컴포저/검색/contentEditable) 포커스 중에는 단축키 미발화.
  if (ctx.inputActive) return 'none';
  // 모달/오버레이가 열려 있으면 Esc 는 그것을 닫는 데 우선 소비된다.
  if (ctx.modalOpen) return 'none';
  return e.shiftKey ? 'mark-all' : 'mark-current';
}
