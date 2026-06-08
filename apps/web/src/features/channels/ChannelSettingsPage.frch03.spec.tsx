// @vitest-environment jsdom
/**
 * FR-CH-03 (065) — ChannelSettingsPage 기본 채널 삭제 보호 회귀고정.
 *
 * 기본 채널(워크스페이스 상세의 defaultChannelId === channel.id)이면 좌측 nav 의
 * "채널 삭제" action 이 비활성(disabled) + 사유(aria-label/title)로 노출돼야 한다.
 * 비기본 채널이면 활성. 또한 서버 가드(409 DEFAULT_CHANNEL_PROTECTED) 응답이
 * graceful 토스트로 폴백되는지(에러 errorCode 분기) 고정한다.
 *
 * 의존(useWorkspace·useChannels·notification-store·ChannelPermissionsTab)은 vi.fn
 * 으로 격리한다(외부 모킹 라이브러리 금지). 라우팅은 MemoryRouter.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Channel } from '@qufox/shared-types';

const WS = '11111111-1111-4111-8111-111111111111';
const CH = '33333333-3333-4333-8333-333333333333';
const OTHER_CH = '44444444-4444-4444-8444-444444444444';

// 워크스페이스 상세 — defaultChannelId 만 테스트가 좌우한다.
let defaultChannelId: string | null = null;
vi.mock('../workspaces/useWorkspaces', () => ({
  useWorkspace: () => ({ data: { id: WS, defaultChannelId } }),
}));

// notification-store: 토스트 push 캡처.
const pushMock = vi.fn();
vi.mock('../../stores/notification-store', () => ({
  useNotifications: (sel: (_state: { push: typeof pushMock }) => unknown) =>
    sel({ push: pushMock }),
}));

// useChannels: 삭제/수정 뮤테이션 격리. deleteMut 의 mutateAsync 를 테스트가 좌우한다.
const deleteMutateAsync = vi.fn();
vi.mock('./useChannels', () => ({
  useDeleteChannel: () => ({ mutateAsync: deleteMutateAsync }),
  useUpdateChannel: () => ({ mutateAsync: vi.fn() }),
}));

// 권한 탭 / 일괄 삭제 / privacy confirm 은 이 스펙 범위 밖 — 가벼운 스텁.
vi.mock('./ChannelPermissionsTab', () => ({
  ChannelPermissionsTab: () => null,
}));
vi.mock('./ChannelPrivacyConfirmModal', () => ({
  ChannelPrivacyConfirmModal: () => null,
}));
vi.mock('../messages/api', () => ({
  bulkDeleteMessages: vi.fn(),
}));

import { ChannelSettingsPage } from './ChannelSettingsPage';

function makeChannel(id: string): Channel & { name: string } {
  return {
    id,
    workspaceId: WS,
    categoryId: null,
    name: 'general',
    type: 'TEXT',
    topic: null,
    description: null,
    position: '1000',
    slowmodeSeconds: 0,
    memberCanPin: true,
    fileUploadEnabled: true,
    maxFileSizeBytes: null,
    isPrivate: false,
    archivedAt: null,
    deletedAt: null,
    createdAt: '2025-01-01T00:00:00.000Z',
  };
}

function renderPage(channelId: string) {
  return render(
    <MemoryRouter>
      <ChannelSettingsPage
        workspaceId={WS}
        workspaceSlug="ws"
        channel={makeChannel(channelId)}
        section="permissions"
      />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  defaultChannelId = null;
  pushMock.mockReset();
  deleteMutateAsync.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('FR-CH-03 · ChannelSettingsPage 기본 채널 삭제 보호', () => {
  it('기본 채널이면 "채널 삭제" 항목이 비활성 + 사유가 노출된다', () => {
    defaultChannelId = CH; // 현재 채널이 기본
    renderPage(CH);
    const del = screen.getByTestId('channel-settings-nav-delete') as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    expect(del.getAttribute('aria-disabled')).toBe('true');
    expect(del.getAttribute('aria-label')).toContain('기본 채널은 삭제할 수 없습니다');
    expect(del.getAttribute('title')).toBe('기본 채널은 삭제할 수 없습니다');
  });

  it('비기본 채널이면 "채널 삭제" 항목이 활성이다', () => {
    defaultChannelId = OTHER_CH; // 기본은 다른 채널
    renderPage(CH);
    const del = screen.getByTestId('channel-settings-nav-delete') as HTMLButtonElement;
    expect(del.disabled).toBe(false);
    expect(del.getAttribute('aria-label')).toBeNull();
  });

  it('워크스페이스 상세 미로딩(기본 미정) 시 삭제 항목은 활성이다(서버가 최종 게이트)', () => {
    defaultChannelId = null;
    renderPage(CH);
    const del = screen.getByTestId('channel-settings-nav-delete') as HTMLButtonElement;
    expect(del.disabled).toBe(false);
  });

  it('비활성 항목 클릭은 삭제 확인 다이얼로그를 열지 않는다', () => {
    defaultChannelId = CH;
    renderPage(CH);
    fireEvent.click(screen.getByTestId('channel-settings-nav-delete'));
    expect(screen.queryByTestId('channel-settings-delete-confirm')).toBeNull();
  });

  it('서버 409 DEFAULT_CHANNEL_PROTECTED 응답을 graceful 토스트로 폴백한다', async () => {
    defaultChannelId = OTHER_CH; // UI 는 활성(경합 시나리오) — 서버가 거부
    deleteMutateAsync.mockRejectedValueOnce(
      Object.assign(new Error('server raw message'), {
        errorCode: 'DEFAULT_CHANNEL_PROTECTED',
      }),
    );
    renderPage(CH);
    fireEvent.click(screen.getByTestId('channel-settings-nav-delete'));
    fireEvent.click(screen.getByTestId('channel-settings-delete-confirm'));

    await vi.waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: 'danger',
          title: '채널 삭제 실패',
          body: expect.stringContaining('기본 채널은 삭제할 수 없습니다'),
        }),
      );
    });
  });
});
