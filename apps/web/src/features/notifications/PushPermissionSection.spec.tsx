// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * S86 (FR-MN-15): PushPermissionSection 단위 — 첫 진입 자동 요청 금지, 버튼 클릭 시에만
 * enablePush 호출, denied 카피 + 도움말 링크, granted/unsupported 분기. enablePush /
 * resolvePushPermission 은 mock 으로 격리(실 권한 요청·구독 없음).
 */
const pushMock = vi.fn();
vi.mock('../../stores/notification-store', () => ({
  useNotifications: (selector: (s: { push: typeof pushMock }) => unknown) =>
    selector({ push: pushMock }),
}));

const resolvePushPermission = vi.fn();
const enablePush = vi.fn();
vi.mock('./webPush', () => ({
  resolvePushPermission: () => resolvePushPermission(),
  enablePush: () => enablePush(),
}));

import { PushPermissionSection } from './PushPermissionSection';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  pushMock.mockClear();
  resolvePushPermission.mockReset();
  enablePush.mockReset();
});
afterEach(() => cleanup());

describe('PushPermissionSection — 첫 진입 자동 요청 금지', () => {
  it('마운트 시 resolvePushPermission(읽기)만 호출하고 enablePush(요청)는 호출하지 않는다', () => {
    resolvePushPermission.mockReturnValue('default');
    render(<PushPermissionSection />);
    expect(resolvePushPermission).toHaveBeenCalled();
    expect(enablePush).not.toHaveBeenCalled();
  });
});

describe('PushPermissionSection — default 상태', () => {
  it('"브라우저 알림 허용하기" 버튼을 보여주고, 클릭 시에만 enablePush 를 호출한다', async () => {
    resolvePushPermission.mockReturnValue('default');
    enablePush.mockResolvedValue({ outcome: 'subscribed' });
    render(<PushPermissionSection />);
    const btn = screen.getByTestId('push-enable-button');
    expect(btn.textContent).toContain('브라우저 알림 허용하기');
    expect(enablePush).not.toHaveBeenCalled();
    fireEvent.click(btn);
    await waitFor(() => expect(enablePush).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith(expect.objectContaining({ variant: 'success' })),
    );
  });

  it('클릭 결과가 denied 면 danger 토스트로 안내한다', async () => {
    resolvePushPermission.mockReturnValueOnce('default').mockReturnValue('denied');
    enablePush.mockResolvedValue({ outcome: 'denied' });
    render(<PushPermissionSection />);
    fireEvent.click(screen.getByTestId('push-enable-button'));
    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith(expect.objectContaining({ variant: 'danger' })),
    );
  });
});

describe('PushPermissionSection — denied 상태', () => {
  it('차단 안내 카피 + "알림 설정 방법 보기" 링크를 보여주고 버튼은 없다', () => {
    resolvePushPermission.mockReturnValue('denied');
    render(<PushPermissionSection />);
    expect(screen.getByTestId('push-denied').textContent).toContain(
      '브라우저 알림이 차단되어 있습니다. 사이트 권한 설정에서 알림을 허용한 후 새로고침해 주세요.',
    );
    expect(screen.getByTestId('push-denied-help').textContent).toContain('알림 설정 방법 보기');
    expect(screen.queryByTestId('push-enable-button')).toBeNull();
  });
});

describe('PushPermissionSection — granted / unsupported 상태', () => {
  it('granted 면 허용됨 안내를 보여준다', () => {
    resolvePushPermission.mockReturnValue('granted');
    render(<PushPermissionSection />);
    expect(screen.getByTestId('push-granted').textContent).toContain(
      '브라우저 알림이 허용되어 있습니다.',
    );
    expect(screen.queryByTestId('push-enable-button')).toBeNull();
  });

  it('unsupported 면 미지원 안내를 보여준다', () => {
    resolvePushPermission.mockReturnValue('unsupported');
    render(<PushPermissionSection />);
    expect(screen.getByTestId('push-unsupported').textContent).toContain(
      '이 브라우저는 푸시 알림을 지원하지 않습니다.',
    );
  });
});
