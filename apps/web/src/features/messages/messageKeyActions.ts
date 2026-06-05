import type { MessageDto, WorkspaceRole } from '@qufox/shared-types';
import { canStartThread } from './threadActionGate';

/**
 * S83b (FR-KS-08): 메시지 단일키 액션.
 *
 * 메시지에 마우스 hover 또는 키보드 포커스 시 단일 키로 액션을 실행한다:
 *   E      = 편집(내 메시지만)
 *   R      = 반응(이모지 피커)
 *   T      = 스레드 열기
 *   P      = 핀 / 언핀
 *   A      = 북마크(저장 토글)
 *   M      = 리마인더
 *   Delete = 삭제(내 메시지만 · 2단계 확인 — 호출부에서 처리)
 *
 * S83b 리뷰 fix-forward: 활성화 메커니즘을 키보드 포커스 전용(roving tabindex)으로
 * 단일화했다. hover 는 기존 툴바 노출만 유지하고 단일키를 트리거하지 않는다(WCAG
 * 2.1.4 위반·SR 가상커서 충돌 제거). 포커스 경로는 2.1.4 'active-on-focus' 예외 충족.
 * Backspace 단일키는 삭제 하이재킹 위험으로 제거했다(Delete 만 · 2단계 확인).
 *
 * 권한/가용성 게이트는 서버 게이트 및 기존 툴바/MoreMenu 노출 조건과 정합해야
 * 한다. 이 순수 헬퍼는 "키 + 컨텍스트 → 액션 enum | null" 만 결정해 단위 검증으로
 * 고정하고, 실제 부수효과(편집 진입·모달 오픈·mutation)는 호출부가 수행한다.
 */
export type MessageKeyAction =
  | 'edit'
  | 'react'
  | 'thread'
  | 'pin'
  | 'unpin'
  | 'save'
  | 'reminder'
  | 'delete';

/**
 * 단일키 가용성 컨텍스트. MessageList 가 per-message 핸들러를 구성할 때 이미 알고
 * 있는 사실(어떤 prop 을 넘겼는지 + viewer 권한)을 그대로 전달한다.
 */
export interface MessageKeyContext {
  isMine: boolean;
  /** onToggleReaction prop 이 존재(채널 컨텍스트 · 비-tmp 등 부모 게이트 통과). */
  canReact: boolean;
  /** onOpenThread prop 이 존재(canStartThread 는 내부에서 재확인). */
  hasOpenThread: boolean;
  /** viewer 의 워크스페이스 role(없으면 null — DM 등). */
  viewerRole: WorkspaceRole | null;
  /** 채널 핀 권한 토글(MEMBER 의 핀 허용 여부 · 서버 게이트와 정합). */
  memberCanPin: boolean;
  /** onPin prop 존재(부모가 wsId + 비-tmp + 미핀일 때만 전달). */
  hasPin: boolean;
  /** onUnpin prop 존재(부모가 wsId + 비-tmp + 핀일 때만 전달). */
  hasUnpin: boolean;
  /** onToggleSave prop 존재(비-tmp). */
  hasSave: boolean;
  /** 리마인더 가용(워크스페이스/DM 무관하게 비-tmp 면 저장 후 리마인더 가능). */
  hasReminder: boolean;
}

/**
 * pin/unpin 권한 게이트. MessageItem 의 MoreMenu 조건과 동일하게 유지한다
 * (OWNER/ADMIN 또는 MEMBER && memberCanPin).
 */
export function canPinByRole(viewerRole: WorkspaceRole | null, memberCanPin: boolean): boolean {
  return (
    viewerRole === 'OWNER' || viewerRole === 'ADMIN' || (viewerRole === 'MEMBER' && memberCanPin)
  );
}

/**
 * 단일키 → 액션 결정. 입력 키는 KeyboardEvent.key(대소문자 무관) 또는 'Delete'.
 * 권한/가용성 미충족이면 null(무동작). 키가 매핑에 없어도 null.
 *
 * ★주의: 이 헬퍼는 "입력 포커스 가드(inInput)" 를 *알지 못한다* — 호출부가 입력
 * 포커스 시 아예 이 함수를 부르지 않는다(타이핑 방해 금지).
 */
export function resolveMessageKeyAction(
  key: string,
  msg: Pick<MessageDto, 'id' | 'parentMessageId' | 'deleted' | 'pinnedAt'>,
  ctx: MessageKeyContext,
): MessageKeyAction | null {
  // S83b 리뷰 fix-forward (reviewer MAJOR-1 · a11y #8 · security #4): Backspace 를
  // 단일키 매핑에서 제거한다(Delete 키만). Backspace 는 SR 가상커서/일반 탐색에서
  // 흔히 쓰여 의도치 않은 삭제(하이재킹) 위험이 크다. Delete 는 대소문자 변환 대상이
  // 아니므로 원본 key 로 먼저 분기한다.
  if (key === 'Delete') {
    return ctx.isMine ? 'delete' : null;
  }
  const k = key.toLowerCase();
  switch (k) {
    case 'e':
      return ctx.isMine ? 'edit' : null;
    case 'r':
      return ctx.canReact ? 'react' : null;
    case 't':
      // canStartThread 가 tmp/답글/삭제/핸들러 부재를 재확인한다.
      return ctx.hasOpenThread && canStartThread(msg, true) ? 'thread' : null;
    case 'p': {
      if (!canPinByRole(ctx.viewerRole, ctx.memberCanPin)) return null;
      if (msg.pinnedAt) return ctx.hasUnpin ? 'unpin' : null;
      return ctx.hasPin ? 'pin' : null;
    }
    case 'a':
      return ctx.hasSave ? 'save' : null;
    case 'm':
      return ctx.hasReminder ? 'reminder' : null;
    default:
      return null;
  }
}

/**
 * 액션 실행 시 스크린리더로 통지할 한국어 문구.
 *
 * S83b 리뷰 fix-forward (a11y MINOR #9): 비동기 액션(pin/unpin/save)은 발화 시점에
 * 아직 완료되지 않았으므로 완료형("~했습니다") 대신 진행형("~합니다/요청했습니다")으로
 * 통지한다(성공/실패 결과는 기존 toast 가 별도로 안내). edit/react/thread 는 즉시
 * 동기 UI 전환이라 완료형을 유지한다. delete 는 2단계 확인이라 호출부가 별도 문구를
 * 통지하므로 여기서는 폴백 문구만 둔다.
 */
export function announceForAction(action: MessageKeyAction): string {
  switch (action) {
    case 'edit':
      return '메시지 편집 모드로 전환했습니다';
    case 'react':
      return '이모지 피커를 열었습니다';
    case 'thread':
      return '스레드를 열었습니다';
    case 'pin':
      return '메시지 고정을 요청합니다';
    case 'unpin':
      return '메시지 고정 해제를 요청합니다';
    case 'save':
      return '북마크 전환을 요청합니다';
    case 'reminder':
      // S83b round-2 (reviewer/a11y MED #8): 리마인더 모달은 동기적으로 열리므로(즉시
      // 마운트) 완료형으로 통지한다("엽니다"→"열었습니다").
      return '리마인더 설정을 열었습니다';
    case 'delete':
      return '메시지 삭제를 진행합니다';
    default:
      return '';
  }
}
