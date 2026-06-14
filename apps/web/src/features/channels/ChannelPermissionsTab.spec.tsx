// @vitest-environment jsdom
/**
 * 072 백로그 S-J (FR-RM14) — ChannelPermissionsTab 멤버별(USER) 오버라이드 편집 검증.
 *
 * 멤버 선택 select + 기존 override 목록 + 3-state 토글이 memberMut.mutate 를, "오버라이드
 * 해제"가 deleteMut.mutate(행 id)를 올바른 인자로 호출하는지 고정한다. 의존 훅
 * (useChannelPermissions·useUpsertChannelOverride·useRoles·useMembers·notification-store)은
 * vi.fn 으로 격리(외부 모킹 라이브러리 금지).
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { ChannelPermissionOverride } from '@qufox/shared-types';

const WS = '11111111-1111-4111-8111-111111111111';
const CH = '33333333-3333-4333-8333-333333333333';

// 오버라이드 목록 — 테스트가 좌우. 기본: ROLE MEMBER + USER alice(쓰기 허용).
let overrides: ChannelPermissionOverride[] = [];
vi.mock('./useChannelPermissions', () => ({
  useChannelPermissions: () => ({ data: { overrides }, isLoading: false }),
  useUpsertChannelOverride: () => ({ roleMut, memberMut, deleteMut }),
}));

// mutate 모킹은 전달된 onSuccess 를 동기 호출해 컴포넌트의 성공 경로(포커스 복원·live
// region·select 리셋)를 검증 가능하게 한다.
const roleMut = { mutate: vi.fn(), isPending: false };
const memberMut = {
  mutate: vi.fn((_input: unknown, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.()),
  isPending: false,
};
const deleteMut = {
  mutate: vi.fn((_id: string, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.()),
  isPending: false,
};

// 멤버 디렉터리 + 역할.
vi.mock('../workspaces/useWorkspaces', () => ({
  useRoles: () => ({ data: [] }),
  useMembers: () => ({
    data: {
      members: [
        {
          userId: 'u-alice',
          workspaceId: WS,
          role: 'MEMBER',
          user: { id: 'u-alice', username: 'alice' },
        },
        {
          userId: 'u-bob',
          workspaceId: WS,
          role: 'MEMBER',
          user: { id: 'u-bob', username: 'bob' },
        },
      ],
    },
    isLoading: false,
  }),
}));

const pushMock = vi.fn();
vi.mock('../../stores/notification-store', () => ({
  useNotifications: (sel: (_state: { push: typeof pushMock }) => unknown) =>
    sel({ push: pushMock }),
}));

import { ChannelPermissionsTab } from './ChannelPermissionsTab';

function aliceOverride(): ChannelPermissionOverride {
  return {
    id: 'ov-alice',
    channelId: CH,
    principalType: 'USER',
    principalId: 'u-alice',
    allowMask: '2', // WRITE_MESSAGE
    denyMask: '0',
  };
}

beforeEach(() => {
  overrides = [];
  // mockClear(구현 보존) — mockReset 은 onSuccess 호출 구현을 지워버린다.
  roleMut.mutate.mockClear();
  memberMut.mutate.mockClear();
  deleteMut.mutate.mockClear();
  pushMock.mockReset();
});
afterEach(() => cleanup());

describe('ChannelPermissionsTab — 멤버별 오버라이드 (072 S-J)', () => {
  it('멤버 select 에 멤버가 채워지고, override 보유 멤버는 표식이 붙는다', () => {
    overrides = [aliceOverride()];
    render(<ChannelPermissionsTab workspaceId={WS} channelId={CH} />);
    const select = screen.getByTestId('channel-perm-member-select') as HTMLSelectElement;
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels).toContain('alice (오버라이드 있음)');
    expect(labels).toContain('bob');
  });

  it('기존 USER override 가 멤버 목록에 +allow/-deny 와 함께 노출된다', () => {
    overrides = [aliceOverride()];
    render(<ChannelPermissionsTab workspaceId={WS} channelId={CH} />);
    const row = screen.getByTestId('channel-perm-member-row-u-alice');
    expect(row).toBeTruthy();
    expect(row.textContent).toContain('alice');
    expect(row.textContent).toContain('+1'); // allow=0x2 → 1비트
    expect(row.textContent).toContain('-0');
  });

  it('멤버 선택 후 권한 토글이 memberMut.mutate 를 userId+마스크로 호출한다', () => {
    overrides = [];
    render(<ChannelPermissionsTab workspaceId={WS} channelId={CH} />);
    fireEvent.change(screen.getByTestId('channel-perm-member-select'), {
      target: { value: 'u-bob' },
    });
    // READ 비트(0x1) 토글 — inherit → allow.
    fireEvent.click(screen.getByTestId('channel-perm-member-toggle-1'));
    expect(memberMut.mutate).toHaveBeenCalledTimes(1);
    expect(memberMut.mutate.mock.calls[0][0]).toEqual({
      userId: 'u-bob',
      allowMask: 1,
      denyMask: 0,
    });
  });

  it('override 보유 멤버 선택 시 "오버라이드 해제"가 deleteMut.mutate(행 id)를 호출한다', () => {
    overrides = [aliceOverride()];
    render(<ChannelPermissionsTab workspaceId={WS} channelId={CH} />);
    fireEvent.click(screen.getByTestId('channel-perm-member-row-u-alice'));
    fireEvent.click(screen.getByTestId('channel-perm-member-remove'));
    expect(deleteMut.mutate).toHaveBeenCalledTimes(1);
    expect(deleteMut.mutate.mock.calls[0][0]).toBe('ov-alice');
  });

  it('override 없는 멤버 선택 시 "오버라이드 해제" 버튼이 없다', () => {
    overrides = [];
    render(<ChannelPermissionsTab workspaceId={WS} channelId={CH} />);
    fireEvent.change(screen.getByTestId('channel-perm-member-select'), {
      target: { value: 'u-bob' },
    });
    expect(screen.queryByTestId('channel-perm-member-remove')).toBeNull();
  });

  // F5 (review MEDIUM · SC 1.3.1): 멤버 행 버튼이 +N/-N 의미를 aria-label 로 풀어준다.
  it('멤버 행 버튼은 허용/거부 개수를 서술하는 aria-label 을 갖는다', () => {
    overrides = [aliceOverride()];
    render(<ChannelPermissionsTab workspaceId={WS} channelId={CH} />);
    const row = screen.getByTestId('channel-perm-member-row-u-alice');
    expect(row.getAttribute('aria-label')).toBe('alice, 허용 1개, 거부 0개');
  });

  // F3 (review BLOCKER · SC 2.4.3) + F4 (review HIGH · SC 4.1.3): 해제 성공 시 안정적인
  // 멤버 select 로 포커스가 복원되고, 완료가 항상 마운트된 live region 에 안내된다.
  it('오버라이드 해제 성공 시 멤버 select 로 포커스 복원 + live region 완료 안내', () => {
    overrides = [aliceOverride()];
    render(<ChannelPermissionsTab workspaceId={WS} channelId={CH} />);
    fireEvent.click(screen.getByTestId('channel-perm-member-row-u-alice'));
    fireEvent.click(screen.getByTestId('channel-perm-member-remove'));
    // deleteMut.mutate 모킹이 onSuccess 를 호출 → 포커스 복원 + live region 갱신.
    const select = screen.getByTestId('channel-perm-member-select');
    expect(document.activeElement).toBe(select);
    expect(screen.getByTestId('channel-perm-member-status').textContent).toBe(
      '멤버 오버라이드를 해제했어요.',
    );
  });
});
