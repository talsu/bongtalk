// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SavedMessageDto } from '@qufox/shared-types';

// S51 (D10 / FR-PS-07): SavedView 3탭 렌더 + 탭 전환 + 삭제 placeholder 마스킹 검증.

const listMock = vi.fn();
const countMock = vi.fn();
const unsaveMock = vi.fn();

vi.mock('./api', () => ({
  listSaved: (...a: unknown[]) => listMock(...a),
  getSavedCount: () => countMock(),
  saveMessage: vi.fn(),
  unsaveMessage: (...a: unknown[]) => unsaveMock(...a),
}));

import { SavedView } from './SavedView';

function item(over: Partial<SavedMessageDto>): SavedMessageDto {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    messageId: '22222222-2222-2222-2222-222222222222',
    status: 'IN_PROGRESS',
    savedAt: '2025-01-01T00:00:00.000Z',
    messageDeletedAt: null,
    excerpt: 'hello world',
    authorId: '33333333-3333-3333-3333-333333333333',
    channelId: '44444444-4444-4444-4444-444444444444',
    channelName: 'general',
    ...over,
  };
}

function renderView(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <SavedView />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  listMock.mockReset();
  countMock.mockReset();
  unsaveMock.mockReset();
  countMock.mockResolvedValue({ count: 2 });
});

afterEach(() => cleanup());

describe('SavedView (FR-PS-07)', () => {
  it('IN_PROGRESS 탭에 항목과 카운트 배지를 렌더한다', async () => {
    listMock.mockResolvedValue({ items: [item({})], nextCursor: null });
    renderView();
    expect(
      await screen.findByTestId('saved-item-22222222-2222-2222-2222-222222222222'),
    ).toBeTruthy();
    expect(screen.getByText('hello world')).toBeTruthy();
    expect(screen.getByTestId('saved-tab-IN_PROGRESS')).toBeTruthy();
    // 카운트 배지(2).
    expect(await screen.findByText('2')).toBeTruthy();
  });

  it('삭제된 원본은 placeholder 로 마스킹된다', async () => {
    listMock.mockResolvedValue({
      items: [item({ messageDeletedAt: '2025-01-01T00:00:00.000Z', excerpt: '[삭제된 메시지]' })],
      nextCursor: null,
    });
    renderView();
    expect(await screen.findByText('[삭제된 메시지]')).toBeTruthy();
  });

  it('탭 전환 시 해당 status 로 목록을 다시 조회한다', async () => {
    listMock.mockResolvedValue({ items: [], nextCursor: null });
    renderView();
    // 초기엔 IN_PROGRESS.
    expect(listMock).toHaveBeenCalledWith('IN_PROGRESS', { limit: 50 });
    fireEvent.click(screen.getByTestId('saved-tab-ARCHIVED'));
    expect(listMock).toHaveBeenCalledWith('ARCHIVED', { limit: 50 });
  });

  it('항목이 없으면 빈 상태를 표시한다', async () => {
    listMock.mockResolvedValue({ items: [], nextCursor: null });
    renderView();
    expect(await screen.findByText('저장한 메시지가 없습니다')).toBeTruthy();
  });
});
