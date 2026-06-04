// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const createMutateAsync = vi.fn().mockResolvedValue(undefined);
vi.mock('./useWorkspaces', () => ({
  useCreateInvite: () => ({ mutateAsync: createMutateAsync, isPending: false }),
}));

import { CreateInviteModal } from './CreateInviteModal';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  createMutateAsync.mockClear();
});

function renderModal(): void {
  render(<CreateInviteModal workspaceId="ws-1" open onOpenChange={() => undefined} />);
}

describe('S67 CreateInviteModal (FR-W02)', () => {
  it('기본값(7일 만료·무제한·영구)으로 expiresAt 을 ISO 로 보내고 maxUses/temporary 를 생략/false 로 보냅니다', async () => {
    renderModal();
    fireEvent.click(screen.getByTestId('create-invite-submit'));
    await vi.waitFor(() => expect(createMutateAsync).toHaveBeenCalled());
    const body = createMutateAsync.mock.calls[0][0];
    // 7일 = 10080분 뒤(고정 시각 2025-01-01T00:00:00Z 기준 2025-01-08).
    expect(body.expiresAt).toBe('2025-01-08T00:00:00.000Z');
    expect(body.maxUses).toBeUndefined();
    expect(body.temporary).toBe(false);
    cleanup();
  });

  it('무제한 만료 + maxUses=5 + temporary=true 를 정확히 보냅니다', async () => {
    renderModal();
    fireEvent.change(screen.getByTestId('invite-expiry'), { target: { value: 'never' } });
    fireEvent.change(screen.getByTestId('invite-max-uses'), { target: { value: '5' } });
    fireEvent.click(screen.getByTestId('invite-temporary'));
    fireEvent.click(screen.getByTestId('create-invite-submit'));
    await vi.waitFor(() => expect(createMutateAsync).toHaveBeenCalled());
    const body = createMutateAsync.mock.calls[0][0];
    expect(body.expiresAt).toBeUndefined();
    expect(body.maxUses).toBe(5);
    expect(body.temporary).toBe(true);
    cleanup();
  });

  it('30분 만료를 선택하면 30분 뒤 ISO 를 보냅니다', async () => {
    renderModal();
    fireEvent.change(screen.getByTestId('invite-expiry'), { target: { value: '30' } });
    fireEvent.click(screen.getByTestId('create-invite-submit'));
    await vi.waitFor(() => expect(createMutateAsync).toHaveBeenCalled());
    const body = createMutateAsync.mock.calls[0][0];
    expect(body.expiresAt).toBe('2025-01-01T00:30:00.000Z');
    cleanup();
  });

  it('(a11y M-3) 임시 멤버십 체크박스는 aria-label 없이 래퍼 라벨 텍스트로 명명되고 설명은 aria-describedby 로 분리됩니다', () => {
    renderModal();
    const checkbox = screen.getByTestId('invite-temporary');
    // aria-label 제거(가드 FP 회피 + 간결한 접근명) — 래퍼 <label>("임시 멤버십")가 명명한다.
    expect(checkbox.getAttribute('aria-label')).toBeNull();
    expect(checkbox.getAttribute('aria-describedby')).toBe('invite-temporary-desc');
    // getByLabelText 로 접근명이 "임시 멤버십" 임을 확인(label 연결 검증).
    expect(screen.getByLabelText('임시 멤버십')).toBe(checkbox);
    // 설명 span 이 연결 id 로 존재.
    const desc = document.getElementById('invite-temporary-desc');
    expect(desc?.textContent).toContain('연결이 끊기면');
    cleanup();
  });
});
