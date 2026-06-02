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
  // S49 fix-forward (a11y BLK-02): announce() 가 requestAnimationFrame 으로 재공지하므로
  // 테스트에서는 동기 실행으로 스텁해 결정적으로 검증한다.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
    cb(0);
    return 0;
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

  it('해제 성공 시 aria-live 리전에 SR 통지 (마지막 1개 해제 → 빈상태 통지 포함)', () => {
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
    // S49 fix-forward (a11y BLK-03): 잔여 0 → 빈상태 통지 덧붙임.
    expect(screen.getByTestId('mute-list-live').textContent).toBe(
      'general 채널 뮤트를 해제했습니다. 뮤트 목록이 비었습니다.',
    );
  });

  it('S49 fix-forward (a11y BLK-03): 잔여가 남으면 빈상태 문구 없이 단건 통지', () => {
    channelItems = [
      {
        channelId: 'c1',
        channelName: 'general',
        workspaceId: 'ws-1',
        workspaceName: 'Acme',
        mutedUntil: null,
        createdAt: '2025-01-01T00:00:00Z',
      },
      {
        channelId: 'c2',
        channelName: 'random',
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

  it('S49 fix-forward (a11y BLK-02): 동일 채널명 연속 해제 시 재공지(rAF 비움→재설정)', () => {
    channelItems = [
      {
        channelId: 'c1',
        channelName: 'general',
        workspaceId: 'ws-1',
        workspaceName: 'Acme',
        mutedUntil: null,
        createdAt: '2025-01-01T00:00:00Z',
      },
      {
        channelId: 'c2',
        channelName: 'random',
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
    const live = screen.getByTestId('mute-list-live');
    fireEvent.click(screen.getByTestId('unmute-channel-c1'));
    expect(live.textContent).toBe('general 채널 뮤트를 해제했습니다.');
    // 두 번째 해제도 announce 가 한 번 비우고 다시 채워 재공지된다(rAF 스텁이 동기 실행).
    // 단위 테스트의 데이터는 정적이라 잔여 카운트는 2 기준(remaining=1)이므로 빈상태
    // 문구는 붙지 않는다 — 재공지 자체(textContent 가 두 번째 메시지로 갱신됨)를 검증.
    fireEvent.click(screen.getByTestId('unmute-channel-c2'));
    expect(live.textContent).toBe('random 채널 뮤트를 해제했습니다.');
  });

  it('S49 fix-forward (a11y): live 리전에 aria-atomic=true', () => {
    render(<MuteListSection />);
    expect(screen.getByTestId('mute-list-live').getAttribute('aria-atomic')).toBe('true');
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

  it('S49 fix-forward (a11y BLK-01): 채널 해제 버튼 aria-label 에 워크스페이스 컨텍스트', () => {
    render(<MuteListSection />);
    // 채널: `${workspaceName ?? 'DM'} ${channelName} 뮤트 해제`.
    expect(screen.getByLabelText('Acme general 뮤트 해제')).toBeTruthy();
    // 서버: `${workspaceName} 서버 뮤트 해제`.
    expect(screen.getByLabelText('Beta 서버 뮤트 해제')).toBeTruthy();
  });

  it('S49 fix-forward (a11y BLK-01): DM 채널 해제 버튼 aria-label 은 "DM" 컨텍스트', () => {
    channelItems = [
      {
        channelId: 'dm1',
        channelName: 'friend42',
        workspaceId: null,
        workspaceName: null,
        mutedUntil: null,
        createdAt: '2025-01-01T00:00:00Z',
      },
    ];
    serverItems = [];
    render(<MuteListSection />);
    expect(screen.getByLabelText('DM friend42 뮤트 해제')).toBeTruthy();
  });

  it('남은 시간이 <time dateTime> 으로 표현', () => {
    render(<MuteListSection />);
    const card = screen.getByTestId('mute-channel-c1');
    const time = within(card).getByText('약 3시간 남음');
    expect(time.tagName).toBe('TIME');
    expect(time.getAttribute('datetime')).toBe('2025-01-01T03:00:00Z');
  });

  it('S49 fix-forward (a11y MOD-02): 무기한이면 <time> 대신 <span>(빈 dateTime 회피)', () => {
    channelItems = [
      {
        channelId: 'c9',
        channelName: 'general',
        workspaceId: 'ws-1',
        workspaceName: 'Acme',
        mutedUntil: null,
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
    render(<MuteListSection />);
    const chCard = screen.getByTestId('mute-channel-c9');
    const chInfinite = within(chCard).getByText('무기한');
    expect(chInfinite.tagName).toBe('SPAN');
    expect(chInfinite.hasAttribute('datetime')).toBe(false);
    const svCard = screen.getByTestId('mute-server-ws-9');
    const svInfinite = within(svCard).getByText('무기한');
    expect(svInfinite.tagName).toBe('SPAN');
    expect(svInfinite.hasAttribute('datetime')).toBe(false);
  });

  it('S49 fix-forward (a11y MIN-01): 워크스페이스 채널은 장식 "#"(aria-hidden), DM 은 "#" 미표시', () => {
    channelItems = [
      {
        channelId: 'c1',
        channelName: 'general',
        workspaceId: 'ws-1',
        workspaceName: 'Acme',
        mutedUntil: null,
        createdAt: '2025-01-01T00:00:00Z',
      },
      {
        channelId: 'dm1',
        channelName: 'friend42',
        workspaceId: null,
        workspaceName: null,
        mutedUntil: null,
        createdAt: '2025-01-01T00:00:00Z',
      },
    ];
    serverItems = [];
    render(<MuteListSection />);
    // 워크스페이스 채널: '#' 표시 + aria-hidden.
    const wsCard = screen.getByTestId('mute-channel-c1');
    const hash = within(wsCard).getByText('#');
    expect(hash.getAttribute('aria-hidden')).toBe('true');
    // DM 채널: '#' 미표시.
    const dmCard = screen.getByTestId('mute-channel-dm1');
    expect(within(dmCard).queryByText('#')).toBeNull();
  });

  it('aria-live 리전 role=status + polite', () => {
    render(<MuteListSection />);
    const live = screen.getByTestId('mute-list-live');
    expect(live.getAttribute('role')).toBe('status');
    expect(live.getAttribute('aria-live')).toBe('polite');
  });
});
