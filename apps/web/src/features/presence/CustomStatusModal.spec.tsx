// @vitest-environment jsdom
/**
 * 072-N2-1 — CustomStatusModal 저장/지우기/초기화 회귀고정.
 *
 *  - 열릴 때 현재 상태(useCustomStatus)로 text/emoji 초기화.
 *  - 텍스트+프리셋 저장 → PUT /users/me/status {text, emoji, preset}.
 *  - text·emoji 모두 비면 저장이 DELETE(지우기)로 폴백.
 *  - '상태 지우기' → DELETE /users/me/status.
 *
 * apiRequest 단일 경계만 vi.fn 모킹(실제 useCustomStatus 훅 동작). EmojiPicker 는
 * 열지 않으므로 커스텀이모지 쿼리는 발생하지 않는다.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const apiRequest = vi.fn();
vi.mock('../../lib/api', () => ({
  apiRequest: (path: string, opts?: unknown) => apiRequest(path, opts),
}));

import { CustomStatusModal } from './CustomStatusModal';

function wrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }): JSX.Element {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

function newQc() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  apiRequest.mockReset();
});
afterEach(() => cleanup());

describe('CustomStatusModal', () => {
  it('현재 상태로 초기화하고 텍스트+프리셋 저장 시 PUT 한다', async () => {
    apiRequest.mockImplementation(async (path: string, opts?: { method?: string; body?: unknown }) => {
      const method = opts?.method ?? 'GET';
      if (path === '/users/me/status' && method === 'GET')
        return { text: '점심', emoji: '🍙', expiresAt: null };
      if (path === '/users/me/status' && method === 'PUT')
        return { text: (opts?.body as { text: string }).text, emoji: null, expiresAt: null };
      throw new Error(`unexpected ${method} ${path}`);
    });
    render(<CustomStatusModal open onOpenChange={() => undefined} />, { wrapper: wrapper(newQc()) });

    // 현재 상태로 텍스트 초기화.
    const input = (await screen.findByTestId('custom-status-text')) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('점심'));

    fireEvent.change(input, { target: { value: '회의 중' } });
    fireEvent.change(screen.getByTestId('custom-status-expiry'), { target: { value: 'one_hour' } });
    fireEvent.click(screen.getByTestId('custom-status-save'));

    await waitFor(() => {
      expect(apiRequest).toHaveBeenCalledWith(
        '/users/me/status',
        expect.objectContaining({
          method: 'PUT',
          body: expect.objectContaining({ text: '회의 중', preset: 'one_hour' }),
        }),
      );
    });
  });

  it("text·emoji 모두 비우고 저장하면 DELETE(지우기)로 폴백한다", async () => {
    apiRequest.mockImplementation(async (path: string, opts?: { method?: string }) => {
      const method = opts?.method ?? 'GET';
      if (path === '/users/me/status' && method === 'GET')
        return { text: '점심', emoji: null, expiresAt: null };
      if (path === '/users/me/status' && method === 'DELETE')
        return { text: null, emoji: null, expiresAt: null };
      throw new Error(`unexpected ${method} ${path}`);
    });
    render(<CustomStatusModal open onOpenChange={() => undefined} />, { wrapper: wrapper(newQc()) });
    const input = (await screen.findByTestId('custom-status-text')) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('점심'));
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('custom-status-save'));
    await waitFor(() => {
      expect(apiRequest).toHaveBeenCalledWith(
        '/users/me/status',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  it("'상태 지우기' 버튼은 DELETE 한다", async () => {
    apiRequest.mockImplementation(async (path: string, opts?: { method?: string }) => {
      const method = opts?.method ?? 'GET';
      if (path === '/users/me/status' && method === 'GET')
        return { text: '점심', emoji: '🍙', expiresAt: null };
      if (path === '/users/me/status' && method === 'DELETE')
        return { text: null, emoji: null, expiresAt: null };
      throw new Error(`unexpected ${method} ${path}`);
    });
    render(<CustomStatusModal open onOpenChange={() => undefined} />, { wrapper: wrapper(newQc()) });
    await screen.findByTestId('custom-status-modal');
    await waitFor(() =>
      expect((screen.getByTestId('custom-status-clear') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByTestId('custom-status-clear'));
    await waitFor(() => {
      expect(apiRequest).toHaveBeenCalledWith(
        '/users/me/status',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });
});
