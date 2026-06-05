/**
 * S83b (FR-KS-08): 메시지 단일키 액션 결정 헬퍼 검증.
 *
 * resolveMessageKeyAction 은 "키 + 메시지 + 가용성 컨텍스트 → 액션 enum | null"
 * 만 결정한다. 권한 게이트(isMine / pin-by-role / prop 존재)와 키 매핑을 단위로
 * 고정해, 부수효과(편집 진입·모달·mutation)는 호출부에서 검증한다.
 */
import { describe, it, expect } from 'vitest';
import type { MessageDto } from '@qufox/shared-types';
import {
  resolveMessageKeyAction,
  canPinByRole,
  announceForAction,
  type MessageKeyContext,
} from './messageKeyActions';

type MsgLite = Pick<MessageDto, 'id' | 'parentMessageId' | 'deleted' | 'pinnedAt'>;

function msg(overrides: Partial<MsgLite> = {}): MsgLite {
  return {
    id: 'm-1',
    parentMessageId: null,
    deleted: false,
    pinnedAt: null,
    ...overrides,
  };
}

function ctx(overrides: Partial<MessageKeyContext> = {}): MessageKeyContext {
  return {
    isMine: true,
    canReact: true,
    hasOpenThread: true,
    viewerRole: 'OWNER',
    memberCanPin: true,
    hasPin: true,
    hasUnpin: true,
    hasSave: true,
    hasReminder: true,
    ...overrides,
  };
}

describe('resolveMessageKeyAction — key mapping', () => {
  it('maps E → edit, R → react, T → thread, A → save, M → reminder', () => {
    expect(resolveMessageKeyAction('e', msg(), ctx())).toBe('edit');
    expect(resolveMessageKeyAction('r', msg(), ctx())).toBe('react');
    expect(resolveMessageKeyAction('t', msg(), ctx())).toBe('thread');
    expect(resolveMessageKeyAction('a', msg(), ctx())).toBe('save');
    expect(resolveMessageKeyAction('m', msg(), ctx())).toBe('reminder');
  });

  it('is case-insensitive for letter keys (uppercase E)', () => {
    expect(resolveMessageKeyAction('E', msg(), ctx())).toBe('edit');
    expect(resolveMessageKeyAction('R', msg(), ctx())).toBe('react');
  });

  it('maps Delete → delete', () => {
    expect(resolveMessageKeyAction('Delete', msg(), ctx())).toBe('delete');
  });

  // S83b 리뷰 fix-forward (reviewer MAJOR-1 · a11y #8 · security #4): Backspace 는
  // 단일키 삭제 매핑에서 제거됐다(삭제 하이재킹 위험 — Delete 만).
  it('Backspace is no longer a delete key (null)', () => {
    expect(resolveMessageKeyAction('Backspace', msg(), ctx())).toBeNull();
    expect(resolveMessageKeyAction('Backspace', msg(), ctx({ isMine: false }))).toBeNull();
  });

  it('returns null for unmapped keys', () => {
    expect(resolveMessageKeyAction('x', msg(), ctx())).toBeNull();
    expect(resolveMessageKeyAction('Enter', msg(), ctx())).toBeNull();
    expect(resolveMessageKeyAction(' ', msg(), ctx())).toBeNull();
  });
});

describe('resolveMessageKeyAction — isMine gate (E / Delete)', () => {
  it('E is null when not my message', () => {
    expect(resolveMessageKeyAction('e', msg(), ctx({ isMine: false }))).toBeNull();
  });
  it('Delete is null when not my message', () => {
    expect(resolveMessageKeyAction('Delete', msg(), ctx({ isMine: false }))).toBeNull();
  });
});

describe('resolveMessageKeyAction — react gate', () => {
  it('R is null when canReact is false (no onToggleReaction prop)', () => {
    expect(resolveMessageKeyAction('r', msg(), ctx({ canReact: false }))).toBeNull();
  });
});

describe('resolveMessageKeyAction — thread gate', () => {
  it('T is null without an open-thread handler', () => {
    expect(resolveMessageKeyAction('t', msg(), ctx({ hasOpenThread: false }))).toBeNull();
  });
  it('T is null for a reply (parentMessageId set)', () => {
    expect(resolveMessageKeyAction('t', msg({ parentMessageId: 'root-1' }), ctx())).toBeNull();
  });
  it('T is null for a tmp (optimistic) row', () => {
    expect(resolveMessageKeyAction('t', msg({ id: 'tmp-123' }), ctx())).toBeNull();
  });
  it('T is null for a deleted message', () => {
    expect(resolveMessageKeyAction('t', msg({ deleted: true }), ctx())).toBeNull();
  });
});

describe('resolveMessageKeyAction — pin gate (P)', () => {
  it('OWNER can pin an unpinned message', () => {
    expect(resolveMessageKeyAction('p', msg(), ctx({ viewerRole: 'OWNER' }))).toBe('pin');
  });
  it('ADMIN can pin', () => {
    expect(resolveMessageKeyAction('p', msg(), ctx({ viewerRole: 'ADMIN' }))).toBe('pin');
  });
  it('MEMBER can pin only when memberCanPin', () => {
    expect(
      resolveMessageKeyAction('p', msg(), ctx({ viewerRole: 'MEMBER', memberCanPin: true })),
    ).toBe('pin');
    expect(
      resolveMessageKeyAction('p', msg(), ctx({ viewerRole: 'MEMBER', memberCanPin: false })),
    ).toBeNull();
  });
  it('null role (DM) cannot pin', () => {
    expect(resolveMessageKeyAction('p', msg(), ctx({ viewerRole: null }))).toBeNull();
  });
  it('pinned message → unpin (when hasUnpin)', () => {
    expect(resolveMessageKeyAction('p', msg({ pinnedAt: '2025-01-01T00:00:00Z' }), ctx())).toBe(
      'unpin',
    );
  });
  it('P is null when role passes but no pin/unpin handler (tmp row hidden by parent)', () => {
    expect(resolveMessageKeyAction('p', msg(), ctx({ hasPin: false }))).toBeNull();
    expect(
      resolveMessageKeyAction(
        'p',
        msg({ pinnedAt: '2025-01-01T00:00:00Z' }),
        ctx({ hasUnpin: false }),
      ),
    ).toBeNull();
  });
});

describe('resolveMessageKeyAction — save / reminder gates', () => {
  it('A is null when hasSave is false (tmp row)', () => {
    expect(resolveMessageKeyAction('a', msg(), ctx({ hasSave: false }))).toBeNull();
  });
  it('M is null when hasReminder is false (tmp row)', () => {
    expect(resolveMessageKeyAction('m', msg(), ctx({ hasReminder: false }))).toBeNull();
  });
});

describe('canPinByRole', () => {
  it('OWNER/ADMIN always; MEMBER gated; null never', () => {
    expect(canPinByRole('OWNER', false)).toBe(true);
    expect(canPinByRole('ADMIN', false)).toBe(true);
    expect(canPinByRole('MEMBER', true)).toBe(true);
    expect(canPinByRole('MEMBER', false)).toBe(false);
    expect(canPinByRole(null, true)).toBe(false);
  });
});

describe('announceForAction', () => {
  it('produces polite Korean SR strings per action', () => {
    expect(announceForAction('edit')).toContain('편집');
    expect(announceForAction('react')).toContain('이모지');
    expect(announceForAction('thread')).toContain('스레드');
    expect(announceForAction('pin')).toContain('고정');
    expect(announceForAction('unpin')).toContain('해제');
    expect(announceForAction('save')).toContain('북마크');
    expect(announceForAction('reminder')).toContain('리마인더');
    expect(announceForAction('delete')).toContain('삭제');
  });
});
