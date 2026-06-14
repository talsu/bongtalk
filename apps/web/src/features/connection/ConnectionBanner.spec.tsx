// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ConnectionBanner } from './ConnectionBanner';

/**
 * 072 백로그 S-H (N6-3): ConnectionBanner 렌더 — failed 종단 상태는 "새로고침" 액션을
 * 노출하고, 일시 상태(disconnected)는 노출하지 않는다. navigator.onLine 은 jsdom 기본 true.
 */
afterEach(() => cleanup());

describe('ConnectionBanner (072 S-H)', () => {
  it('realtimeStatus=failed → 배너 + 새로고침 버튼 노출(reloadable)', () => {
    render(<ConnectionBanner realtimeStatus="failed" replaying={false} />);
    const banner = screen.getByTestId('connection-banner');
    expect(banner.getAttribute('data-level')).toBe('failed');
    expect(screen.getByTestId('connection-banner-reload')).toBeTruthy();
  });

  it('realtimeStatus=disconnected → 배너는 뜨지만 새로고침 버튼은 없다(자동 재연결 중)', () => {
    render(<ConnectionBanner realtimeStatus="disconnected" replaying={false} />);
    expect(screen.getByTestId('connection-banner').getAttribute('data-level')).toBe('disconnected');
    expect(screen.queryByTestId('connection-banner-reload')).toBeNull();
  });

  it('connected + 비-replay → 배너 미렌더', () => {
    render(<ConnectionBanner realtimeStatus="connected" replaying={false} />);
    expect(screen.queryByTestId('connection-banner')).toBeNull();
  });
});
