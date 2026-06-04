// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * S75 fix-forward (F13): 차단 해제(useUnblockUser) 성공 시 ['friends'] 뿐 아니라
 * ['messages'] 캐시도 무효화해야, 열린 채널/DM 의 `[차단된 사용자의 메시지]`
 * 마스킹이 풀린 원문으로 재로드된다.
 */
const apiRequestMock = vi.fn();
vi.mock('../../lib/api', () => ({
  apiRequest: (path: string, opts?: unknown) => apiRequestMock(path, opts),
}));

import { useUnblockUser } from './useFriends';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  apiRequestMock.mockReset();
  apiRequestMock.mockResolvedValue({});
});

afterEach(() => cleanup());

describe('useUnblockUser (F13)', () => {
  it('invalidates both friends and messages caches on success', async () => {
    const qc = new QueryClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }): JSX.Element => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useUnblockUser(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ userId: 'u-blocked' });
    });

    await waitFor(() => {
      const keys = invalidateSpy.mock.calls.map((c) => JSON.stringify(c[0]));
      expect(keys).toContain(JSON.stringify({ queryKey: ['friends'] }));
      expect(keys).toContain(JSON.stringify({ queryKey: ['messages'] }));
    });
    // DELETE /me/friends/block/:userId 로 호출.
    expect(apiRequestMock).toHaveBeenCalledWith(
      '/me/friends/block/u-blocked',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});
