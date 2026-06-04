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
// S72 (FR-W15): 삭제 뮤테이션 스파이.
const deleteMutate = vi.fn().mockResolvedValue({ deleteAt: '2025-01-31T00:00:00.000Z' });

vi.mock('./useWorkspaces', () => ({
  useUpdateWorkspace: () => ({ mutateAsync: updateMutate }),
  useTransferOwnership: () => ({ mutateAsync: transferMutate, isPending: false }),
  useUpdateDefaultChannel: () => ({ mutateAsync: defaultChannelMutate, isPending: false }),
  useLeaveWorkspace: () => ({ mutateAsync: leaveMutate, isPending: false }),
  useDeleteWorkspace: () => ({ mutateAsync: deleteMutate, isPending: false }),
}));

// 위험 구역과 무관한 패널 컴포넌트는 스텁한다(렌더 트리 단순화).
vi.mock('../emojis/WorkspaceEmojiManager', () => ({ WorkspaceEmojiManager: () => null }));
vi.mock('./roles/RolesModal', () => ({ RolesManager: () => null }));
vi.mock('./moderation/AuditLogPanel', () => ({ AuditLogPanel: () => null }));
vi.mock('./moderation/ReportQueuePanel', () => ({ ReportQueuePanel: () => null }));
// S67 (FR-W17): 초대 관리 패널은 위험 구역 테스트와 무관하므로 스텁한다.
vi.mock('./InviteManagerPanel', () => ({ InviteManagerPanel: () => null }));

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
  deleteMutate.mockClear();
  navigateSpy.mockClear();
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

describe('WorkspaceSettingsPage — 워크스페이스 삭제 (FR-W15)', () => {
  it('slug 불일치 입력은 삭제 버튼이 비활성, 정확 일치 시 활성화되고 mutate(slug)가 호출된다', async () => {
    renderOwner();
    // 위험 구역의 삭제 진입 버튼으로 확인 모달을 연다.
    fireEvent.click(screen.getByTestId('ws-delete-open'));
    const confirmOk = screen.getByTestId('ws-delete-confirm-ok') as HTMLButtonElement;
    // 입력 전 — 비활성.
    expect(confirmOk.disabled).toBe(true);
    const input = screen.getByTestId('ws-delete-confirm-input') as HTMLInputElement;
    // 불일치 입력 — 여전히 비활성.
    fireEvent.change(input, { target: { value: 'wrong-slug' } });
    expect(confirmOk.disabled).toBe(true);
    // 정확히 slug("acme") 입력 — 활성화.
    fireEvent.change(input, { target: { value: 'acme' } });
    expect(confirmOk.disabled).toBe(false);
    fireEvent.click(confirmOk);
    expect(deleteMutate).toHaveBeenCalledWith('acme');
  });

  it('삭제 성공 시 홈(/dm)으로 리다이렉트한다', async () => {
    renderOwner();
    fireEvent.click(screen.getByTestId('ws-delete-open'));
    fireEvent.change(screen.getByTestId('ws-delete-confirm-input'), {
      target: { value: 'acme' },
    });
    fireEvent.click(screen.getByTestId('ws-delete-confirm-ok'));
    // mutateAsync 가 resolve 된 다음 navigate 가 호출되도록 마이크로태스크를 비운다.
    await Promise.resolve();
    await Promise.resolve();
    expect(navigateSpy).toHaveBeenCalledWith('/dm');
  });

  it('비-OWNER 에게는 삭제 진입 버튼이 노출되지 않는다', () => {
    render(
      <WorkspaceSettingsPage
        workspace={baseWorkspace}
        myRole="MEMBER"
        workspaceSlug="acme"
        members={members}
        channels={channels}
      />,
    );
    expect(screen.queryByTestId('ws-delete-open')).toBeNull();
  });

  // S72 fix-forward (a11y L-1): 삭제 트리거 버튼은 다이얼로그를 여는 트리거임을 알린다.
  it('삭제 진입 버튼에 aria-haspopup="dialog" 가 있다', () => {
    renderOwner();
    expect(screen.getByTestId('ws-delete-open').getAttribute('aria-haspopup')).toBe('dialog');
  });

  // S72 fix-forward (a11y H-2): slug 불일치가 입력의 aria-invalid + role=status 메시지로 AT 에 전달된다.
  it('불일치 입력은 aria-invalid + role=status 메시지를 노출하고, 일치하면 사라진다', () => {
    renderOwner();
    fireEvent.click(screen.getByTestId('ws-delete-open'));
    const input = screen.getByTestId('ws-delete-confirm-input') as HTMLInputElement;
    // 빈 입력 — 아직 오류 아님(invalid off, 메시지 없음).
    expect(input.getAttribute('aria-invalid')).not.toBe('true');
    expect(screen.queryByTestId('ws-delete-confirm-mismatch')).toBeNull();
    // 불일치 입력 — invalid on + status 메시지 + describedby 연결.
    fireEvent.change(input, { target: { value: 'wrong' } });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const msg = screen.getByTestId('ws-delete-confirm-mismatch');
    expect(msg.getAttribute('role')).toBe('status');
    expect(input.getAttribute('aria-describedby')).toBe('ws-delete-confirm-mismatch');
    // 정확 일치 — invalid off + 메시지 제거.
    fireEvent.change(input, { target: { value: 'acme' } });
    expect(input.getAttribute('aria-invalid')).not.toBe('true');
    expect(screen.queryByTestId('ws-delete-confirm-mismatch')).toBeNull();
  });

  // S72 fix-forward (a11y H-2): 식별자 입력은 브라우저 자동완성/맞춤법 검사를 끈다.
  it('식별자 입력에 autoComplete=off + spellCheck=false 가 설정된다', () => {
    renderOwner();
    fireEvent.click(screen.getByTestId('ws-delete-open'));
    const input = screen.getByTestId('ws-delete-confirm-input') as HTMLInputElement;
    expect(input.getAttribute('autocomplete')).toBe('off');
    expect(input.getAttribute('spellcheck')).toBe('false');
  });

  // S72 fix-forward (a11y B-1): 삭제 실패 에러는 모달 내부에서 role=alert 로 알린다.
  it('삭제 실패 시 모달 내부에 role=alert 에러가 뜬다(모달 밖 dangerErr 와 분리)', async () => {
    deleteMutate.mockRejectedValueOnce(new Error('삭제에 실패했습니다.'));
    renderOwner();
    fireEvent.click(screen.getByTestId('ws-delete-open'));
    fireEvent.change(screen.getByTestId('ws-delete-confirm-input'), { target: { value: 'acme' } });
    fireEvent.click(screen.getByTestId('ws-delete-confirm-ok'));
    await Promise.resolve();
    await Promise.resolve();
    const alert = await screen.findByTestId('ws-delete-error');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toContain('삭제에 실패했습니다.');
    // 모달 밖 위험구역 에러(dangerErr)는 영향받지 않는다.
    expect(screen.queryByTestId('ws-danger-error')).toBeNull();
    // 리다이렉트하지 않는다(실패).
    expect(navigateSpy).not.toHaveBeenCalledWith('/dm');
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
