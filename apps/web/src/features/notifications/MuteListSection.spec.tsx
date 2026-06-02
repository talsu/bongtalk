// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import type { ActiveChannelMute, ActiveServerMute } from '@qufox/shared-types';

let channelItems: ActiveChannelMute[] = [];
let serverItems: ActiveServerMute[] = [];
const removeChannelMutate = vi.fn();
const unmuteServerMutate = vi.fn();

vi.mock('../channels/useMutes', () => ({
  useMutes: () => ({ data: { items: channelItems } }),
  useRemoveChannelMute: () => ({ mutate: removeChannelMutate, isPending: false }),
}));

vi.mock('./useNotifLevels', () => ({
  useServerMutes: () => ({ data: { items: serverItems } }),
  useUnmuteServerFromList: () => ({ mutate: unmuteServerMutate, isPending: false }),
}));

const pushToast = vi.fn();
vi.mock('../../stores/notification-store', () => ({
  useNotifications: (selector: (s: { push: typeof pushToast }) => unknown) =>
    selector({ push: pushToast }),
}));

import { MuteListSection } from './MuteListSection';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  channelItems = [];
  serverItems = [];
  removeChannelMutate.mockReset();
  unmuteServerMutate.mockReset();
  pushToast.mockReset();
});
afterEach(cleanup);

describe('MuteListSection (S49 FR-MN-17)', () => {
  it('빈 상태 — "뮤트 중인 채널/서버가 없습니다" + count 0', () => {
    render(<MuteListSection />);
    expect(screen.getByTestId('mute-list-empty').textContent).toContain(
      '뮤트 중인 채널/서버가 없습니다',
    );
    expect(screen.getByTestId('mute-list-count').textContent).toBe('0');
  });

  it('채널/서버 뮤트 카드 렌더 + count 합계', () => {
    channelItems = [
      {
        channelId: 'c1',
        channelName: 'general',
        workspaceId: 'ws-1',
        workspaceName: 'Acme',
        mutedUntil: '2025-01-01T01:00:00Z',
        createdAt: '2025-01-01T00:00:00Z',
      },
    ];
    serverItems = [
      {
        workspaceId: 'ws-1',
        workspaceName: 'Acme',
        workspaceIconUrl: null,
        muteUntil: null,
        level: 'MENTIONS',
      },
    ];
    render(<MuteListSection />);
    expect(screen.getByTestId('mute-list-count').textContent).toBe('2');
    expect(screen.getByTestId('mute-channel-c1').textContent).toContain('general');
    expect(screen.getByTestId('mute-channel-c1').textContent).toContain('Acme');
    expect(screen.getByTestId('mute-channel-c1').textContent).toContain('약 1시간 남음');
    expect(screen.getByTestId('mute-server-ws-1').textContent).toContain('Acme');
    expect(screen.getByTestId('mute-server-ws-1').textContent).toContain('무기한');
  });

  it('DM 채널(workspaceName 없음)은 "DM ·" 접두', () => {
    channelItems = [
      {
        channelId: 'dm1',
        channelName: '친구 그룹',
        workspaceId: null,
        workspaceName: null,
        mutedUntil: null,
        createdAt: '2025-01-01T00:00:00Z',
      },
    ];
    render(<MuteListSection />);
    expect(screen.getByTestId('mute-channel-dm1').textContent).toContain('DM ·');
  });

  it('채널 해제 버튼 → useRemoveChannelMute.mutate(channelId)', () => {
    channelItems = [
      {
        channelId: 'c1',
        channelName: 'general',
        workspaceId: 'ws-1',
        workspaceName: 'Acme',
        mutedUntil: null,
        createdAt: '2025-01-01T00:00:00Z',
      },
    ];
    render(<MuteListSection />);
    fireEvent.click(screen.getByTestId('unmute-channel-c1'));
    expect(removeChannelMutate).toHaveBeenCalledTimes(1);
    expect(removeChannelMutate.mock.calls[0][0]).toBe('c1');
  });

  it('서버 해제 버튼 → useUnmuteServerFromList.mutate(workspaceId)', () => {
    serverItems = [
      {
        workspaceId: 'ws-9',
        workspaceName: 'Beta',
        workspaceIconUrl: null,
        muteUntil: null,
        level: 'NOTHING',
      },
    ];
    render(<MuteListSection />);
    fireEvent.click(screen.getByTestId('unmute-server-ws-9'));
    expect(unmuteServerMutate).toHaveBeenCalledTimes(1);
    expect(unmuteServerMutate.mock.calls[0][0]).toBe('ws-9');
  });

  it('해제 성공 시 aria-live 리전에 SR 통지', () => {
    channelItems = [
      {
        channelId: 'c1',
        channelName: 'general',
        workspaceId: 'ws-1',
        workspaceName: 'Acme',
        mutedUntil: null,
        createdAt: '2025-01-01T00:00:00Z',
      },
    ];
    removeChannelMutate.mockImplementation((_id: string, opts: { onSuccess: () => void }) =>
      opts.onSuccess(),
    );
    render(<MuteListSection />);
    fireEvent.click(screen.getByTestId('unmute-channel-c1'));
    expect(screen.getByTestId('mute-list-live').textContent).toBe(
      'general 채널 뮤트를 해제했습니다.',
    );
  });

  it('해제 실패 시 danger 토스트', () => {
    serverItems = [
      {
        workspaceId: 'ws-9',
        workspaceName: 'Beta',
        workspaceIconUrl: null,
        muteUntil: null,
        level: 'NOTHING',
      },
    ];
    unmuteServerMutate.mockImplementation((_id: string, opts: { onError: (e: Error) => void }) =>
      opts.onError(new Error('boom')),
    );
    render(<MuteListSection />);
    fireEvent.click(screen.getByTestId('unmute-server-ws-9'));
    expect(pushToast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'danger', body: 'boom' }),
    );
  });
});

describe('MuteListSection a11y (S49 — S48 교훈 선반영)', () => {
  beforeEach(() => {
    channelItems = [
      {
        channelId: 'c1',
        channelName: 'general',
        workspaceId: 'ws-1',
        workspaceName: 'Acme',
        mutedUntil: '2025-01-01T03:00:00Z',
        createdAt: '2025-01-01T00:00:00Z',
      },
    ];
    serverItems = [
      {
        workspaceId: 'ws-9',
        workspaceName: 'Beta',
        workspaceIconUrl: null,
        muteUntil: null,
        level: 'NOTHING',
      },
    ];
  });

  it('섹션 heading + aria-labelledby 연결', () => {
    render(<MuteListSection />);
    const section = screen.getByTestId('mute-list-section');
    const labelId = section.getAttribute('aria-labelledby');
    expect(labelId).toBeTruthy();
    expect(document.getElementById(labelId as string)?.textContent).toContain('현재 뮤트 중');
  });

  it('각 목록 <ul> 에 aria-labelledby(채널/서버 소제목)', () => {
    render(<MuteListSection />);
    const chList = screen.getByTestId('mute-list-channels');
    const svList = screen.getByTestId('mute-list-servers');
    expect(chList.tagName).toBe('UL');
    expect(svList.tagName).toBe('UL');
    expect(
      document.getElementById(chList.getAttribute('aria-labelledby') as string)?.textContent,
    ).toBe('채널');
    expect(
      document.getElementById(svList.getAttribute('aria-labelledby') as string)?.textContent,
    ).toBe('서버');
  });

  it('해제 버튼 aria-label=`${name} 뮤트 해제`', () => {
    render(<MuteListSection />);
    expect(screen.getByLabelText('general 뮤트 해제')).toBeTruthy();
    expect(screen.getByLabelText('Beta 뮤트 해제')).toBeTruthy();
  });

  it('남은 시간이 <time dateTime> 으로 표현', () => {
    render(<MuteListSection />);
    const card = screen.getByTestId('mute-channel-c1');
    const time = within(card).getByText('약 3시간 남음');
    expect(time.tagName).toBe('TIME');
    expect(time.getAttribute('datetime')).toBe('2025-01-01T03:00:00Z');
  });

  it('aria-live 리전 role=status + polite', () => {
    render(<MuteListSection />);
    const live = screen.getByTestId('mute-list-live');
    expect(live.getAttribute('role')).toBe('status');
    expect(live.getAttribute('aria-live')).toBe('polite');
  });
});
