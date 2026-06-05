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
 *   Delete = 삭제(내 메시지만)
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
  // Delete 는 대소문자 변환 대상이 아니므로 원본 key 로 먼저 분기한다.
  if (key === 'Delete' || key === 'Backspace') {
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

/** 액션 실행 시 스크린리더로 통지할 한국어 문구. */
export function announceForAction(action: MessageKeyAction): string {
  switch (action) {
    case 'edit':
      return '메시지 편집 모드로 전환했습니다';
    case 'react':
      return '이모지 피커를 열었습니다';
    case 'thread':
      return '스레드를 열었습니다';
    case 'pin':
      return '메시지를 고정했습니다';
    case 'unpin':
      return '메시지 고정을 해제했습니다';
    case 'save':
      return '북마크를 전환했습니다';
    case 'reminder':
      return '리마인더 설정을 엽니다';
    case 'delete':
      return '메시지 삭제를 진행합니다';
    default:
      return '';
  }
}
