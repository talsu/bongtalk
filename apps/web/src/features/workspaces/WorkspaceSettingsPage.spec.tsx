// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

/**
 * S65 (D13 / FR-W13·W19·W14): 워크스페이스 설정 위험 구역의 FE 계약을 jsdom 으로
 * 검증한다 — 기본 채널 셀렉트(공개 채널만)·소유권 양도(비밀번호 재확인)·나가기
 * (OWNER 비활성 + 양도 안내). 데이터/뮤테이션 hook 과 라우팅을 모킹해 네트워크 없이
 * 렌더링한다.
 */

const navigateSpy = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateSpy,
}));

const transferMutate = vi.fn().mockResolvedValue(undefined);
const defaultChannelMutate = vi.fn().mockResolvedValue(undefined);
const leaveMutate = vi.fn().mockResolvedValue(undefined);
const updateMutate = vi.fn().mockResolvedValue(undefined);

vi.mock('./useWorkspaces', () => ({
  useUpdateWorkspace: () => ({ mutateAsync: updateMutate }),
  useTransferOwnership: () => ({ mutateAsync: transferMutate, isPending: false }),
  useUpdateDefaultChannel: () => ({ mutateAsync: defaultChannelMutate, isPending: false }),
  useLeaveWorkspace: () => ({ mutateAsync: leaveMutate, isPending: false }),
}));

// 위험 구역과 무관한 패널 컴포넌트는 스텁한다(렌더 트리 단순화).
vi.mock('../emojis/WorkspaceEmojiManager', () => ({ WorkspaceEmojiManager: () => null }));
vi.mock('./roles/RolesModal', () => ({ RolesManager: () => null }));
vi.mock('./moderation/AuditLogPanel', () => ({ AuditLogPanel: () => null }));
vi.mock('./moderation/ReportQueuePanel', () => ({ ReportQueuePanel: () => null }));

import { WorkspaceSettingsPage } from './WorkspaceSettingsPage';

const baseWorkspace = {
  id: 'ws-1',
  name: 'Acme',
  description: null,
  visibility: 'PRIVATE' as const,
  category: null,
  defaultChannelId: 'chan-general',
};

const members = [
  { userId: 'u-2', username: 'bob' },
  { userId: 'u-3', username: 'carol' },
];

const channels = [
  { id: 'chan-general', name: 'general', isPrivate: false },
  { id: 'chan-lounge', name: 'lounge', isPrivate: false },
  { id: 'chan-secret', name: 'secret', isPrivate: true },
];

function renderOwner(): void {
  render(
    <WorkspaceSettingsPage
      workspace={baseWorkspace}
      myRole="OWNER"
      workspaceSlug="acme"
      members={members}
      channels={channels}
    />,
  );
}

beforeEach(() => {
  transferMutate.mockClear();
  defaultChannelMutate.mockClear();
  leaveMutate.mockClear();
});

afterEach(() => cleanup());

describe('WorkspaceSettingsPage — 기본 채널 (FR-W19)', () => {
  it('공개 채널만 셀렉트 옵션으로 노출한다(비공개 제외)', () => {
    renderOwner();
    const select = screen.getByTestId('ws-default-channel-select') as HTMLSelectElement;
    const optionValues = Array.from(select.options).map((o) => o.value);
    expect(optionValues).toContain('chan-general');
    expect(optionValues).toContain('chan-lounge');
    expect(optionValues).not.toContain('chan-secret');
  });

  it('다른 공개 채널 선택 후 적용하면 mutate 가 호출된다', async () => {
    renderOwner();
    const select = screen.getByTestId('ws-default-channel-select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'chan-lounge' } });
    fireEvent.click(screen.getByTestId('ws-default-channel-save'));
    expect(defaultChannelMutate).toHaveBeenCalledWith('chan-lounge');
  });
});

describe('WorkspaceSettingsPage — 소유권 양도 (FR-W13)', () => {
  it('대상 + 비밀번호를 채워야 양도 버튼이 활성화되고 mutate 가 비밀번호를 포함한다', () => {
    renderOwner();
    const submit = screen.getByTestId('ws-transfer-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByTestId('ws-transfer-target'), { target: { value: 'u-2' } });
    fireEvent.change(screen.getByTestId('ws-transfer-password'), {
      target: { value: 'hunter2-secret' },
    });
    expect(submit.disabled).toBe(false);

    fireEvent.click(submit);
    expect(transferMutate).toHaveBeenCalledWith({
      toUserId: 'u-2',
      password: 'hunter2-secret',
    });
  });
});

describe('WorkspaceSettingsPage — 나가기 (FR-W14)', () => {
  it('OWNER 는 나가기 버튼 비활성 + 양도 안내를 본다', () => {
    renderOwner();
    expect(screen.getByTestId('ws-leave-owner-note')).toBeTruthy();
    expect((screen.getByTestId('ws-leave-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('비-OWNER 는 나가기 버튼이 활성화되고 mutate 가 호출된다', () => {
    render(
      <WorkspaceSettingsPage
        workspace={baseWorkspace}
        myRole="MEMBER"
        workspaceSlug="acme"
        members={members}
        channels={channels}
      />,
    );
    const submit = screen.getByTestId('ws-leave-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    expect(leaveMutate).toHaveBeenCalled();
  });
});
