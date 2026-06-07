// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ChannelNotificationPreference } from '@qufox/shared-types';

/**
 * S87 (FR-MN-18): ChannelNotifSettings — 채널별 데스크톱/모바일 push 토글.
 *
 * useChannelNotificationPref / usePutChannelNotificationPref / notification-store 를 스텁해
 * 렌더·상속 표시·putChannel payload 만 검증한다(네트워크/스토어 격리).
 */
const pushMock = vi.fn();
vi.mock('../../stores/notification-store', () => ({
  useNotifications: (sel: (s: { push: typeof pushMock }) => unknown) => sel({ push: pushMock }),
}));

let pref: ChannelNotificationPreference | undefined;
const putMutate = vi.fn();
vi.mock('./useNotifLevels', () => ({
  useChannelNotificationPref: () => ({ data: pref }),
  usePutChannelNotificationPref: () => ({ mutate: putMutate, isPending: false }),
}));

import { ChannelNotifSettings } from './ChannelNotifSettings';

function renderCmp(globalDesktop = true, globalMobile = true): void {
  render(
    <ChannelNotifSettings
      workspaceId="ws-1"
      channelId="ch-1"
      globalDesktop={globalDesktop}
      globalMobile={globalMobile}
    />,
  );
}

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  pref = { level: null, isMuted: false, muteUntil: null, pushDesktop: null, pushMobile: null };
  putMutate.mockReset();
  pushMock.mockReset();
});
afterEach(() => cleanup());

describe('ChannelNotifSettings — 상속(null) 표시 + effective 반영', () => {
  it('push 값이 null 이면 "전체 설정 따름" 표시 + 글로벌 effective 가 스위치에 반영', () => {
    renderCmp(true, false);
    expect(screen.getByTestId('channel-pushDesktop-inherited')).toBeTruthy();
    expect(screen.getByTestId('channel-pushMobile-inherited')).toBeTruthy();
    // globalDesktop=true → 데스크톱 스위치 checked, globalMobile=false → 모바일 unchecked.
    expect(screen.getByTestId('channel-pushDesktop-toggle').getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(screen.getByTestId('channel-pushMobile-toggle').getAttribute('aria-checked')).toBe(
      'false',
    );
    // 상속 상태면 "전체 설정 따르기" 재설정 버튼은 노출하지 않는다.
    expect(screen.queryByTestId('channel-pushDesktop-reset')).toBeNull();
  });
});

describe('ChannelNotifSettings — putChannel payload', () => {
  it('상속 상태에서 데스크톱 토글을 끄면 pushDesktop=false 로 PUT (effective true → false)', () => {
    renderCmp(true, true);
    fireEvent.click(screen.getByTestId('channel-pushDesktop-toggle'));
    expect(putMutate).toHaveBeenCalledWith({ pushDesktop: false }, expect.anything());
  });

  it('명시 오버라이드(pushMobile=false)면 reset 버튼 노출 + 클릭 시 pushMobile=null PUT', () => {
    pref = { level: null, isMuted: false, muteUntil: null, pushDesktop: null, pushMobile: false };
    renderCmp(true, true);
    // 오버라이드라 상속 라벨은 모바일에 없고 reset 버튼이 보인다.
    expect(screen.queryByTestId('channel-pushMobile-inherited')).toBeNull();
    fireEvent.click(screen.getByTestId('channel-pushMobile-reset'));
    expect(putMutate).toHaveBeenCalledWith({ pushMobile: null }, expect.anything());
  });

  it('명시 false 인 스위치를 켜면 pushMobile=true 로 PUT', () => {
    pref = { level: null, isMuted: false, muteUntil: null, pushDesktop: null, pushMobile: false };
    renderCmp(true, true);
    expect(screen.getByTestId('channel-pushMobile-toggle').getAttribute('aria-checked')).toBe(
      'false',
    );
    fireEvent.click(screen.getByTestId('channel-pushMobile-toggle'));
    expect(putMutate).toHaveBeenCalledWith({ pushMobile: true }, expect.anything());
  });
});
