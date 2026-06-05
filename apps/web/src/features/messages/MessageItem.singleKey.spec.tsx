// @vitest-environment jsdom
/**
 * S83b (FR-KS-08): 메시지 단일키 액션 — MessageItem 키보드 포커스 경로 검증.
 *
 * 메시지 row(role="article", tabIndex=0)에 포커스한 뒤 단일 키(E/R/T/P/A/M/Delete)
 * 를 누르면 각 액션이 동작하는지, 권한/가용성 게이트(isMine / pin-by-role / prop
 * 부재 / 비-tmp)가 정확한지, 입력 포커스 중에는 비활성인지, E/R 이 MessageItem
 * 내부 state(편집 input / 이모지 피커)를 트리거하는지, SR announce 가 불리는지를
 * 검증한다. 기존 정적 렌더 spec(threadChip)과 달리 인터랙션이 필요해 jsdom +
 * testing-library 를 쓴다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import type { MessageDto, WorkspaceRole } from '@qufox/shared-types';

// announce 를 spy 로 잡아 SR 통지 호출을 검증한다.
const announceSpy = vi.fn();
vi.mock('../../lib/a11y-announce', () => ({
  announce: (...args: unknown[]) => announceSpy(...args),
}));

import { MessageItem } from './MessageItem';

// ReactionUsersModal 이 useInfiniteQuery 를 호출하므로 QueryClient 가 필요하다.
function renderWithClient(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function makeMsg(overrides: Partial<MessageDto> = {}): MessageDto {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
    channelId: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000002',
    authorId: 'cccccccc-cccc-4ccc-8ccc-000000000003',
    content: 'hello world',
    contentRaw: 'hello world',
    contentAst: null,
    contentPlain: 'hello world',
    type: 'DEFAULT',
    mentions: { users: [], channels: [], everyone: false, here: false, channel: false },
    edited: false,
    deleted: false,
    createdAt: '2025-01-01T00:00:00.000Z',
    editedAt: null,
    reactions: [],
    parentMessageId: null,
    thread: null,
    attachments: [],
    pinnedAt: null,
    pinnedBy: null,
    version: 0,
    isBroadcast: false,
    parentExcerpt: null,
    threadLocked: false,
    embeds: [],
    ...overrides,
  };
}

interface Handlers {
  onEditSave?: ReturnType<typeof vi.fn>;
  onDelete?: ReturnType<typeof vi.fn>;
  onToggleReaction?: ReturnType<typeof vi.fn>;
  onOpenThread?: ReturnType<typeof vi.fn>;
  onPin?: ReturnType<typeof vi.fn>;
  onUnpin?: ReturnType<typeof vi.fn>;
  onToggleSave?: ReturnType<typeof vi.fn>;
  onSetReminder?: ReturnType<typeof vi.fn>;
  onRovingMove?: ReturnType<typeof vi.fn>;
  onRowFocus?: ReturnType<typeof vi.fn>;
}

function renderItem(opts: {
  msg?: MessageDto;
  isMine?: boolean;
  viewerRole?: WorkspaceRole | null;
  memberCanPin?: boolean;
  isSaved?: boolean;
  focused?: boolean;
  handlers?: Handlers;
}) {
  const h = {
    onEditSave: opts.handlers?.onEditSave ?? vi.fn(),
    onDelete: opts.handlers?.onDelete ?? vi.fn(),
    onToggleReaction: opts.handlers?.onToggleReaction ?? vi.fn(),
    onOpenThread: opts.handlers?.onOpenThread ?? vi.fn(),
    onPin: opts.handlers?.onPin ?? vi.fn(),
    onUnpin: opts.handlers?.onUnpin ?? vi.fn(),
    onToggleSave: opts.handlers?.onToggleSave ?? vi.fn(),
    onSetReminder: opts.handlers?.onSetReminder ?? vi.fn(),
    onRovingMove: opts.handlers?.onRovingMove ?? vi.fn(),
    onRowFocus: opts.handlers?.onRowFocus ?? vi.fn(),
  };
  const utils = renderWithClient(
    <MessageItem
      msg={opts.msg ?? makeMsg()}
      isMine={opts.isMine ?? true}
      // ★ 'viewerRole' in opts 로 명시적 null 과 미제공을 구분한다(`?? 'OWNER'` 로
      // 합치면 의도한 null(DM) 케이스가 OWNER 로 바뀐다 — DM 게이트 테스트 회귀).
      viewerRole={'viewerRole' in opts ? (opts.viewerRole ?? null) : 'OWNER'}
      memberCanPin={opts.memberCanPin ?? true}
      isSaved={opts.isSaved}
      focused={opts.focused}
      onRovingMove={h.onRovingMove}
      onRowFocus={h.onRowFocus}
      onEditSave={h.onEditSave}
      onDelete={h.onDelete}
      onToggleReaction={opts.handlers?.onToggleReaction === null ? undefined : h.onToggleReaction}
      onOpenThread={opts.handlers?.onOpenThread === null ? undefined : h.onOpenThread}
      onPin={opts.handlers?.onPin === null ? undefined : h.onPin}
      onUnpin={opts.handlers?.onUnpin === null ? undefined : h.onUnpin}
      onToggleSave={opts.handlers?.onToggleSave === null ? undefined : h.onToggleSave}
      onSetReminder={opts.handlers?.onSetReminder === null ? undefined : h.onSetReminder}
    />,
  );
  const row = utils.container.querySelector('[role="article"]') as HTMLElement;
  return { ...utils, row, h };
}

function press(row: HTMLElement, key: string): void {
  fireEvent.keyDown(row, { key });
}

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  announceSpy.mockReset();
});
afterEach(() => cleanup());

describe('MessageItem single-key — row accessibility & roving tabindex', () => {
  it('renders the row as a focusable article with an aria-label', () => {
    const { row } = renderItem({});
    expect(row).toBeTruthy();
    expect(row.getAttribute('role')).toBe('article');
    expect(row.getAttribute('aria-label')).toBeTruthy();
  });

  // S83b 리뷰 fix-forward (a11y BLOCKER #1): roving tabindex. focused 행만 0,
  // 나머지는 -1 → 목록 전체가 Tab 한 스톱만 차지(Tab flooding 해소).
  it('focused row has tabindex 0, unfocused row has tabindex -1', () => {
    const { row: focusedRow } = renderItem({ focused: true });
    expect(focusedRow.getAttribute('tabindex')).toBe('0');
    cleanup();
    const { row: unfocusedRow } = renderItem({ focused: false });
    expect(unfocusedRow.getAttribute('tabindex')).toBe('-1');
  });

  it('defaults to tabindex 0 when focused prop is omitted (standalone render)', () => {
    const { row } = renderItem({});
    expect(row.getAttribute('tabindex')).toBe('0');
  });

  it('onFocus syncs the focused row to the parent (roving wiring)', () => {
    const onRowFocus = vi.fn();
    const { row } = renderItem({ handlers: { onRowFocus } });
    fireEvent.focus(row);
    expect(onRowFocus).toHaveBeenCalled();
  });
});

describe('MessageItem single-key — roving move (↑/↓/Home/End)', () => {
  it('ArrowUp / ArrowDown request a roving move from the parent', () => {
    const onRovingMove = vi.fn();
    const { row } = renderItem({ handlers: { onRovingMove } });
    press(row, 'ArrowDown');
    expect(onRovingMove).toHaveBeenCalledWith('ArrowDown');
    press(row, 'ArrowUp');
    expect(onRovingMove).toHaveBeenCalledWith('ArrowUp');
  });

  it('Home / End request a roving move', () => {
    const onRovingMove = vi.fn();
    const { row } = renderItem({ handlers: { onRovingMove } });
    press(row, 'Home');
    press(row, 'End');
    expect(onRovingMove).toHaveBeenCalledWith('Home');
    expect(onRovingMove).toHaveBeenCalledWith('End');
  });

  it('roving keys do not fire single-key actions (no announce)', () => {
    const { row } = renderItem({});
    press(row, 'ArrowDown');
    expect(announceSpy).not.toHaveBeenCalled();
  });
});

describe('MessageItem single-key — E (edit, isMine gate)', () => {
  it('E on my message enters inline edit (internal state) + announces', () => {
    const { row, container } = renderItem({ isMine: true });
    press(row, 'e');
    // 편집 input 이 나타난다(내부 state setEditing 트리거).
    expect(container.querySelector('[data-testid^="msg-edit-"]')).toBeTruthy();
    expect(announceSpy).toHaveBeenCalledWith(expect.stringContaining('편집'));
  });

  it('E on another user message does nothing', () => {
    const { row, container } = renderItem({ isMine: false });
    press(row, 'e');
    expect(container.querySelector('[data-testid^="msg-edit-"]')).toBeFalsy();
    expect(announceSpy).not.toHaveBeenCalled();
  });

  it('uppercase E works (case-insensitive)', () => {
    const { row, container } = renderItem({ isMine: true });
    press(row, 'E');
    expect(container.querySelector('[data-testid^="msg-edit-"]')).toBeTruthy();
  });
});

describe('MessageItem single-key — R (react picker, internal state)', () => {
  it('R opens the reaction picker when onToggleReaction is provided', () => {
    const { row } = renderItem({});
    press(row, 'r');
    expect(announceSpy).toHaveBeenCalledWith(expect.stringContaining('이모지'));
  });

  it('R does nothing without onToggleReaction', () => {
    const { row } = renderItem({ handlers: { onToggleReaction: null as never } });
    press(row, 'r');
    expect(announceSpy).not.toHaveBeenCalled();
  });
});

describe('MessageItem single-key — T (thread)', () => {
  it('T opens the thread via onOpenThread', () => {
    const onOpenThread = vi.fn();
    const { row } = renderItem({ handlers: { onOpenThread } });
    press(row, 't');
    expect(onOpenThread).toHaveBeenCalledWith('aaaaaaaa-aaaa-4aaa-8aaa-000000000001');
    expect(announceSpy).toHaveBeenCalledWith(expect.stringContaining('스레드'));
  });

  it('T does nothing for a reply (parentMessageId)', () => {
    const onOpenThread = vi.fn();
    const { row } = renderItem({
      msg: makeMsg({ parentMessageId: 'root' }),
      handlers: { onOpenThread },
    });
    press(row, 't');
    expect(onOpenThread).not.toHaveBeenCalled();
  });
});

describe('MessageItem single-key — P (pin / unpin, role gate)', () => {
  it('P pins an unpinned message for OWNER', () => {
    const onPin = vi.fn();
    const { row } = renderItem({ viewerRole: 'OWNER', handlers: { onPin } });
    press(row, 'p');
    expect(onPin).toHaveBeenCalled();
    expect(announceSpy).toHaveBeenCalledWith(expect.stringContaining('고정'));
  });

  it('P unpins a pinned message', () => {
    const onUnpin = vi.fn();
    const { row } = renderItem({
      msg: makeMsg({ pinnedAt: '2025-01-01T00:00:00.000Z' }),
      viewerRole: 'ADMIN',
      handlers: { onUnpin },
    });
    press(row, 'p');
    expect(onUnpin).toHaveBeenCalled();
  });

  it('P does nothing for MEMBER when memberCanPin is false', () => {
    const onPin = vi.fn();
    const { row } = renderItem({
      viewerRole: 'MEMBER',
      memberCanPin: false,
      handlers: { onPin },
    });
    press(row, 'p');
    expect(onPin).not.toHaveBeenCalled();
  });

  it('P allows MEMBER when memberCanPin is true', () => {
    const onPin = vi.fn();
    const { row } = renderItem({
      viewerRole: 'MEMBER',
      memberCanPin: true,
      handlers: { onPin },
    });
    press(row, 'p');
    expect(onPin).toHaveBeenCalled();
  });

  it('P does nothing for DM (null role)', () => {
    const onPin = vi.fn();
    const { row } = renderItem({ viewerRole: null, handlers: { onPin } });
    press(row, 'p');
    expect(onPin).not.toHaveBeenCalled();
  });
});

describe('MessageItem single-key — A (bookmark)', () => {
  it('A toggles save (currentlySaved=false → save)', () => {
    const onToggleSave = vi.fn();
    const { row } = renderItem({ isSaved: false, handlers: { onToggleSave } });
    press(row, 'a');
    expect(onToggleSave).toHaveBeenCalledWith(false);
    expect(announceSpy).toHaveBeenCalledWith(expect.stringContaining('북마크'));
  });

  it('A passes currentlySaved=true when already saved', () => {
    const onToggleSave = vi.fn();
    const { row } = renderItem({ isSaved: true, handlers: { onToggleSave } });
    press(row, 'a');
    expect(onToggleSave).toHaveBeenCalledWith(true);
  });

  it('A does nothing without onToggleSave (tmp row)', () => {
    const onToggleSave = vi.fn();
    const { row } = renderItem({ handlers: { onToggleSave: null as never } });
    press(row, 'a');
    expect(onToggleSave).not.toHaveBeenCalled();
  });
});

describe('MessageItem single-key — M (reminder)', () => {
  it('M invokes onSetReminder', () => {
    const onSetReminder = vi.fn();
    const { row } = renderItem({ handlers: { onSetReminder } });
    press(row, 'm');
    expect(onSetReminder).toHaveBeenCalled();
    expect(announceSpy).toHaveBeenCalledWith(expect.stringContaining('리마인더'));
  });

  it('M does nothing without onSetReminder (tmp row)', () => {
    const onSetReminder = vi.fn();
    const { row } = renderItem({ handlers: { onSetReminder: null as never } });
    press(row, 'm');
    expect(onSetReminder).not.toHaveBeenCalled();
  });
});

describe('MessageItem single-key — Delete (isMine gate · 2-step confirm)', () => {
  // S83b 리뷰 fix-forward (reviewer MAJOR-1 · a11y #8): 첫 Delete 는 확인 안내만,
  // 짧은 창 안에 두 번째 Delete 에서만 실제 삭제한다(우발 삭제 방지).
  it('first Delete only arms + announces a confirm prompt (no delete yet)', () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    const { row } = renderItem({ isMine: true, handlers: { onDelete } });
    press(row, 'Delete');
    expect(onDelete).not.toHaveBeenCalled();
    expect(announceSpy).toHaveBeenCalledWith(expect.stringContaining('한 번 더'));
  });

  it('second Delete within the window triggers onDelete', () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    const { row } = renderItem({ isMine: true, handlers: { onDelete } });
    press(row, 'Delete');
    expect(onDelete).not.toHaveBeenCalled();
    press(row, 'Delete');
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(announceSpy).toHaveBeenCalledWith(expect.stringContaining('삭제'));
  });

  it('a non-Delete single key between two Deletes cancels the confirm window', () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    const { row } = renderItem({ isMine: true, handlers: { onDelete } });
    press(row, 'Delete'); // arm
    press(row, 'r'); // 다른 단일키가 끼어들면 무장 해제
    press(row, 'Delete'); // 다시 1단계(재무장)일 뿐 삭제 안 됨
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('Delete on another user message does nothing', () => {
    const onDelete = vi.fn();
    const { row } = renderItem({ isMine: false, handlers: { onDelete } });
    press(row, 'Delete');
    press(row, 'Delete');
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('Backspace no longer triggers delete (hijack guard)', () => {
    const onDelete = vi.fn();
    const { row } = renderItem({ isMine: true, handlers: { onDelete } });
    press(row, 'Backspace');
    press(row, 'Backspace');
    expect(onDelete).not.toHaveBeenCalled();
  });
});

describe('MessageItem single-key — input-focus & edit guards', () => {
  it('does nothing when the key originates from an input/textarea (typing)', () => {
    const onSetReminder = vi.fn();
    const { row, container } = renderItem({ handlers: { onSetReminder } });
    // 가짜 입력 필드를 row 안에 넣고 거기서 keydown 을 발생시킨다.
    const input = document.createElement('input');
    container.querySelector('[role="article"]')?.appendChild(input);
    fireEvent.keyDown(input, { key: 'm' });
    expect(onSetReminder).not.toHaveBeenCalled();
    void row;
  });

  it('does nothing while in inline edit mode (editing input focused)', () => {
    const onSetReminder = vi.fn();
    const { row } = renderItem({ isMine: true, handlers: { onSetReminder } });
    // 편집 모드 진입.
    press(row, 'e');
    announceSpy.mockReset();
    // 편집 중 M 단일키는 비활성(타이핑 방해 금지).
    press(row, 'm');
    expect(onSetReminder).not.toHaveBeenCalled();
  });

  it('ignores modifier-key combos (Ctrl+E should not edit)', () => {
    const { row, container } = renderItem({ isMine: true });
    fireEvent.keyDown(row, { key: 'e', ctrlKey: true });
    expect(container.querySelector('[data-testid^="msg-edit-"]')).toBeFalsy();
  });

  it('ignores unmapped keys', () => {
    const onDelete = vi.fn();
    const { row } = renderItem({ handlers: { onDelete } });
    press(row, 'x');
    expect(announceSpy).not.toHaveBeenCalled();
  });
});

// S83b 리뷰 fix-forward (a11y #2 · #6 · perf): hover-only 단일키 경로(actionRequest
// nonce)는 전면 제거됐다(WCAG 2.1.4 위반·SR 충돌·전체 리렌더 원인). hover 는 기존
// group-hover 툴바 노출만 유지하고 단일키를 트리거하지 않는다. 따라서 종전
// actionRequest 경로 테스트는 삭제하고, 활성화는 키보드 포커스(onKeyDown) 경로로만
// 검증한다(위 describe 블록들).
