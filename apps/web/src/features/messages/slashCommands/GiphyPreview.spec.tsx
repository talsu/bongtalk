// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// HTTP 경계(searchGiphy)는 vi.fn() 으로만 모킹한다(외부 모킹 라이브러리 금지).
const searchGiphy = vi.fn();
vi.mock('./api', () => ({ searchGiphy: (...args: unknown[]) => searchGiphy(...args) }));

import { GiphyPreview } from './GiphyPreview';
import { useGiphyPreviewStore } from './useGiphyPreview';

const WS = 'ws-1';
const CH = 'c1';

function seed(over: Partial<{ offset: number; keyword: string }> = {}): void {
  useGiphyPreviewStore.setState({
    byChannel: {
      [CH]: {
        channelId: CH,
        gifUrl: 'https://media.giphy.com/media/abc/giphy.gif',
        gifThumbUrl: 'https://media.giphy.com/media/abc/200w.gif',
        title: 'cat',
        keyword: over.keyword ?? 'cat',
        offset: over.offset ?? 0,
      },
    },
  });
}

afterEach(() => {
  cleanup();
  searchGiphy.mockReset();
  useGiphyPreviewStore.setState({ byChannel: {} });
});

describe('GiphyPreview (S81b / FR-SC-07)', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  });

  it('프리뷰가 없으면 아무것도 렌더하지 않는다', () => {
    render(<GiphyPreview workspaceId={WS} channelId={CH} onSend={() => {}} />);
    expect(screen.queryByTestId('giphy-preview')).toBeNull();
  });

  it('썸네일 + "Powered By GIPHY" attribution + Shuffle/Send/Cancel 을 렌더한다', () => {
    seed();
    render(<GiphyPreview workspaceId={WS} channelId={CH} onSend={() => {}} />);
    const img = screen.getByTestId('giphy-preview-image') as HTMLImageElement;
    expect(img.getAttribute('src')).toContain('200w.gif');
    expect(screen.getByTestId('giphy-attribution').textContent).toContain('Powered By GIPHY');
    expect(screen.getByTestId('giphy-shuffle')).toBeTruthy();
    expect(screen.getByTestId('giphy-send')).toBeTruthy();
    expect(screen.getByTestId('giphy-cancel')).toBeTruthy();
  });

  it('Shuffle → offset+1 로 searchGiphy 를 호출하고 프리뷰를 교체한다', async () => {
    seed({ offset: 0, keyword: 'cat' });
    searchGiphy.mockResolvedValue({
      gifUrl: 'https://media.giphy.com/media/def/giphy.gif',
      gifThumbUrl: 'https://media.giphy.com/media/def/200w.gif',
      title: 'cat2',
    });
    render(<GiphyPreview workspaceId={WS} channelId={CH} onSend={() => {}} />);
    fireEvent.click(screen.getByTestId('giphy-shuffle'));
    expect(searchGiphy).toHaveBeenCalledWith({
      workspaceId: WS,
      channelId: CH,
      keyword: 'cat',
      offset: 1,
    });
    await waitFor(() => {
      const img = screen.getByTestId('giphy-preview-image') as HTMLImageElement;
      expect(img.getAttribute('src')).toContain('def/200w.gif');
    });
    // 스토어 offset 이 증가했다.
    expect(useGiphyPreviewStore.getState().byChannel[CH].offset).toBe(1);
  });

  it('Shuffle 실패 시 인라인 에러를 표시하고 프리뷰는 유지한다', async () => {
    seed();
    searchGiphy.mockRejectedValue(new Error('더 이상 표시할 GIF 가 없습니다'));
    render(<GiphyPreview workspaceId={WS} channelId={CH} onSend={() => {}} />);
    fireEvent.click(screen.getByTestId('giphy-shuffle'));
    await waitFor(() => {
      expect(screen.getByTestId('giphy-preview-error').textContent).toContain('GIF');
    });
    // 프리뷰는 그대로(스토어에 남아 있음).
    expect(useGiphyPreviewStore.getState().byChannel[CH]).toBeDefined();
  });

  it('Send → onSend(gifUrl) 호출 후 프리뷰를 제거한다', () => {
    seed();
    const onSend = vi.fn();
    render(<GiphyPreview workspaceId={WS} channelId={CH} onSend={onSend} />);
    fireEvent.click(screen.getByTestId('giphy-send'));
    expect(onSend).toHaveBeenCalledWith('https://media.giphy.com/media/abc/giphy.gif');
    expect(useGiphyPreviewStore.getState().byChannel[CH]).toBeUndefined();
  });

  it('Cancel → 서버 호출 없이 프리뷰만 제거한다', () => {
    seed();
    render(<GiphyPreview workspaceId={WS} channelId={CH} onSend={() => {}} />);
    fireEvent.click(screen.getByTestId('giphy-cancel'));
    expect(searchGiphy).not.toHaveBeenCalled();
    expect(useGiphyPreviewStore.getState().byChannel[CH]).toBeUndefined();
  });
});
