// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor, act, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { SavedMessageDto, SavedMessageListResponse } from '@qufox/shared-types';

// S52 (FR-PS-08/13): useUpdateSavedStatus 낙관적 이동 + useInitSavedStatus seed 검증.

const updateMock = vi.fn();
const bulkMock = vi.fn();
const pushMock = vi.fn();

vi.mock('./api', () => ({
  listSaved: vi.fn(),
  getSavedCount: vi.fn(),
  saveMessage: vi.fn(),
  unsaveMessage: vi.fn(),
  updateSavedStatus: (...a: unknown[]) => updateMock(...a),
  savedStatusBulk: (...a: unknown[]) => bulkMock(...a),
}));

vi.mock('../../stores/notification-store', () => ({
  useNotifications: (sel: (s: { push: typeof pushMock }) => unknown) => sel({ push: pushMock }),
}));

import { savedKeys, useUpdateSavedStatus, useInitSavedStatus } from './useSavedMessages';

function dto(over: Partial<SavedMessageDto>): SavedMessageDto {
  return {
    id: 'sm-1',
    messageId: 'm-1',
    status: 'IN_PROGRESS',
    savedAt: '2025-01-01T00:00:00.000Z',
    messageDeletedAt: null,
    excerpt: 'x',
    authorId: 'a',
    channelId: 'c',
    channelName: 'general',
    ...over,
  };
}

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, wrapper };
}

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  updateMock.mockReset();
  bulkMock.mockReset();
  pushMock.mockReset();
});

afterEach(() => cleanup());

describe('useUpdateSavedStatus 낙관적 이동 (FR-PS-08)', () => {
  it('성공 시 from 탭에서 즉시 제거하고 대상 탭(캐시됨)에 끼워 넣는다', async () => {
    const { qc, wrapper } = makeWrapper();
    const moving = dto({ id: 'sm-1', messageId: 'm-1', status: 'IN_PROGRESS' });
    qc.setQueryData<SavedMessageListResponse>(savedKeys.list('IN_PROGRESS'), {
      items: [moving, dto({ id: 'sm-2', messageId: 'm-2' })],
      nextCursor: null,
    });
    qc.setQueryData<SavedMessageListResponse>(savedKeys.list('ARCHIVED'), {
      items: [],
      nextCursor: null,
    });
    updateMock.mockResolvedValue(dto({ id: 'sm-1', status: 'ARCHIVED' }));

    const { result } = renderHook(() => useUpdateSavedStatus(), { wrapper });
    act(() => {
      result.current.mutate({ savedMessageId: 'sm-1', from: 'IN_PROGRESS', to: 'ARCHIVED' });
    });

    // 낙관적: from 탭에서 즉시 제거.
    await waitFor(() => {
      const from = qc.getQueryData<SavedMessageListResponse>(savedKeys.list('IN_PROGRESS'));
      expect(from!.items.map((i) => i.id)).toEqual(['sm-2']);
    });
    // 대상 탭(캐시됨)에 status 갱신해 끼워 넣음.
    const to = qc.getQueryData<SavedMessageListResponse>(savedKeys.list('ARCHIVED'));
    expect(to!.items[0].id).toBe('sm-1');
    expect(to!.items[0].status).toBe('ARCHIVED');

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(updateMock).toHaveBeenCalledWith('sm-1', 'ARCHIVED');
  });

  it('실패 시 from/to 탭을 롤백하고 경고 토스트를 띄운다', async () => {
    const { qc, wrapper } = makeWrapper();
    const moving = dto({ id: 'sm-1', messageId: 'm-1', status: 'IN_PROGRESS' });
    qc.setQueryData<SavedMessageListResponse>(savedKeys.list('IN_PROGRESS'), {
      items: [moving],
      nextCursor: null,
    });
    qc.setQueryData<SavedMessageListResponse>(savedKeys.list('COMPLETED'), {
      items: [],
      nextCursor: null,
    });
    updateMock.mockRejectedValue(new Error('boom'));

    const { result } = renderHook(() => useUpdateSavedStatus(), { wrapper });
    act(() => {
      result.current.mutate({ savedMessageId: 'sm-1', from: 'IN_PROGRESS', to: 'COMPLETED' });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    // 롤백: from 탭에 다시 존재.
    const from = qc.getQueryData<SavedMessageListResponse>(savedKeys.list('IN_PROGRESS'));
    expect(from!.items.map((i) => i.id)).toEqual(['sm-1']);
    expect(pushMock).toHaveBeenCalledWith(expect.objectContaining({ variant: 'warning' }));
  });
});

describe('useInitSavedStatus seed (FR-PS-13)', () => {
  it('bulk 결과로 저장된 id 는 true, 미저장 id 는 false 로 seed 한다', async () => {
    const { qc, wrapper } = makeWrapper();
    bulkMock.mockResolvedValue({ saved: ['m-1'] });

    renderHook(() => useInitSavedStatus(['m-1', 'm-2']), { wrapper });

    await waitFor(() => {
      expect(qc.getQueryData(savedKeys.status('m-1'))).toBe(true);
    });
    expect(qc.getQueryData(savedKeys.status('m-2'))).toBe(false);
    expect(bulkMock).toHaveBeenCalledWith(['m-1', 'm-2']);
  });

  it('빈 배치는 bulk 를 호출하지 않는다(N+1·불필요 호출 방지)', async () => {
    const { wrapper } = makeWrapper();
    renderHook(() => useInitSavedStatus([]), { wrapper });
    await Promise.resolve();
    expect(bulkMock).not.toHaveBeenCalled();
  });

  it('이미 캐시된 id 만 있으면 bulk 를 호출하지 않고 기존 값을 보존한다(perf 증분)', async () => {
    const { qc, wrapper } = makeWrapper();
    // 사용자가 직전에 저장(true)했다 — 이미 seed 됐으므로 재조회하지 않는다.
    qc.setQueryData<boolean>(savedKeys.status('m-1'), true);
    bulkMock.mockResolvedValue({ saved: [] });

    renderHook(() => useInitSavedStatus(['m-1']), { wrapper });
    // S52 리뷰(perf): 미seed id 만 조회 — 전부 캐시면 bulk 무호출(WS 메시지마다 전체
    // 재 POST 하던 회귀 방지). 기존 토글 값은 보존된다.
    await Promise.resolve();
    expect(bulkMock).not.toHaveBeenCalled();
    expect(qc.getQueryData(savedKeys.status('m-1'))).toBe(true);
  });

  it('일부만 캐시된 배치는 미seed id 만 bulk 로 조회한다(증분)', async () => {
    const { qc, wrapper } = makeWrapper();
    qc.setQueryData<boolean>(savedKeys.status('m-1'), true);
    bulkMock.mockResolvedValue({ saved: [] });

    renderHook(() => useInitSavedStatus(['m-1', 'm-2']), { wrapper });
    await waitFor(() => expect(bulkMock).toHaveBeenCalled());
    // 'm-1' 은 이미 캐시 → pending 제외, 'm-2' 만 조회.
    expect(bulkMock).toHaveBeenCalledWith(['m-2']);
    expect(qc.getQueryData(savedKeys.status('m-1'))).toBe(true);
    await waitFor(() => expect(qc.getQueryData(savedKeys.status('m-2'))).toBe(false));
  });
});
