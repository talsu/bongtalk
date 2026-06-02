// @vitest-environment jsdom
/**
 * S40 (FR-RE05) — ReactionUsersModal 접근성 + 페이지네이션 회귀고정.
 *
 * 검증 항목:
 *   - 열린 모달이 role="dialog" 와 aria-labelledby(제목 연결)를 가진다 — DS Dialog 는
 *     Radix Dialog 기반이라 focus trap·Esc·트리거 포커스 복귀를 함께 보장한다(이
 *     버전 Radix 는 aria-modal 속성 대신 focus scope 로 모달성을 강제한다).
 *   - 제목이 이모지를 포함한 완결 라벨로 노출되고 aria-labelledby 가 그것을 가리킨다.
 *   - 서버 응답의 reactor 가 목록 항목으로 렌더된다(username 우선, 없으면 id).
 *   - Esc 키로 닫히면 onOpenChange(false) 가 호출된다(포커스 복귀는 Radix 보장).
 *
 * fetchReactionUsers 는 vi.fn 으로만 모킹한다(외부 모킹 라이브러리 금지).
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { ListReactionUsersResponse } from '@qufox/shared-types';

const fetchReactionUsers = vi.fn();
vi.mock('./api', () => ({
  fetchReactionUsers: (messageId: string, emoji: string, opts?: { cursor?: string }) =>
    fetchReactionUsers(messageId, emoji, opts),
}));

import { ReactionUsersModal } from './ReactionUsersModal';

function wrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }): JSX.Element {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

const MSG = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  fetchReactionUsers.mockReset();
});
afterEach(() => cleanup());

describe('ReactionUsersModal a11y (S40 · FR-RE05)', () => {
  it('열린 모달은 role=dialog + aria-labelledby(제목) 이고 reactor 를 목록으로 렌더한다', async () => {
    const page: ListReactionUsersResponse = {
      users: [
        { id: '22222222-2222-4222-8222-222222222222', username: 'alice' },
        { id: '33333333-3333-4333-8333-333333333333', username: null },
      ],
      nextCursor: null,
    };
    fetchReactionUsers.mockResolvedValue(page);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<ReactionUsersModal messageId={MSG} emoji="👍" open onOpenChange={() => {}} />, {
      wrapper: wrapper(qc),
    });

    const dialog = await screen.findByRole('dialog');
    // 제목에 이모지가 포함되고 aria-labelledby 가 그 제목 노드를 가리킨다.
    const title = screen.getByText('👍 반응한 사람');
    expect(dialog.getAttribute('aria-labelledby')).toBe(title.getAttribute('id'));
    // reactor 목록 — username 우선, 없으면 id.
    await waitFor(() => expect(screen.getByText('alice')).toBeTruthy());
    expect(screen.getByText('33333333-3333-4333-8333-333333333333')).toBeTruthy();
  });

  it('Esc 키로 닫으면 onOpenChange(false) 가 호출된다', async () => {
    fetchReactionUsers.mockResolvedValue({ users: [], nextCursor: null });
    const onOpenChange = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<ReactionUsersModal messageId={MSG} emoji="🎉" open onOpenChange={onOpenChange} />, {
      wrapper: wrapper(qc),
    });
    const dialog = await screen.findByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('닫힌 상태(open=false)에서는 fetch 하지 않는다(enabled 게이트)', () => {
    fetchReactionUsers.mockResolvedValue({ users: [], nextCursor: null });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<ReactionUsersModal messageId={MSG} emoji="👍" open={false} onOpenChange={() => {}} />, {
      wrapper: wrapper(qc),
    });
    expect(fetchReactionUsers).not.toHaveBeenCalled();
  });
});
