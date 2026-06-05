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

  // a11y HIGH-3 + reviewer MED-1 (S81b 리뷰): error 는 role="alert" 로 SR 통지하고, raw
  // err.message 가 아니라 고정 친화 문구만 노출한다(announce 중복 호출 없음).
  it('Shuffle 에러 표시는 role="alert" + 고정 친화 문구(raw 메시지 미노출)', async () => {
    seed();
    searchGiphy.mockRejectedValue(new Error('Zod: invalid_string at gifUrl ...'));
    const announce = vi.fn();
    render(<GiphyPreview workspaceId={WS} channelId={CH} onSend={() => {}} announce={announce} />);
    fireEvent.click(screen.getByTestId('giphy-shuffle'));
    await waitFor(() => {
      const el = screen.getByTestId('giphy-preview-error');
      expect(el.getAttribute('role')).toBe('alert');
      expect(el.textContent).toBe('GIF 를 더 불러오지 못했습니다');
    });
    // role="alert" 가 통지를 담당하므로 catch 에서 announce 를 호출하지 않는다.
    expect(announce).not.toHaveBeenCalled();
  });

  // a11y HIGH-2 (S81b 리뷰): Send 성공 시 SR 통지 + 포커스 복원.
  it('Send 성공 시 announce("GIF 를 채널에 보냈습니다") 후 프리뷰를 제거한다', () => {
    seed();
    const announce = vi.fn();
    render(<GiphyPreview workspaceId={WS} channelId={CH} onSend={() => {}} announce={announce} />);
    fireEvent.click(screen.getByTestId('giphy-send'));
    expect(announce).toHaveBeenCalledWith('GIF 를 채널에 보냈습니다');
    expect(useGiphyPreviewStore.getState().byChannel[CH]).toBeUndefined();
  });

  // reviewer HIGH-1 (S81b 리뷰): 매 렌더 cleanup 재실행으로 preview 가 즉시 삭제되던 회귀.
  // GiphyPreview 가 store 액션을 안정 참조로 구독하므로, rerender 해도 프리뷰가 유지된다.
  it('rerender 후에도 프리뷰가 유지된다(매 렌더 clear 되지 않음)', () => {
    seed();
    const { rerender } = render(<GiphyPreview workspaceId={WS} channelId={CH} onSend={() => {}} />);
    expect(screen.getByTestId('giphy-preview')).toBeTruthy();
    rerender(<GiphyPreview workspaceId={WS} channelId={CH} onSend={() => {}} />);
    rerender(<GiphyPreview workspaceId={WS} channelId={CH} onSend={() => {}} />);
    expect(screen.getByTestId('giphy-preview')).toBeTruthy();
    expect(useGiphyPreviewStore.getState().byChannel[CH]).toBeDefined();
  });

  // a11y BLK-1 (S81b 리뷰): 컨테이너 role/aria-label.
  it('컨테이너에 role="group" + aria-label 을 노출한다', () => {
    seed();
    render(<GiphyPreview workspaceId={WS} channelId={CH} onSend={() => {}} />);
    const card = screen.getByTestId('giphy-preview');
    expect(card.getAttribute('role')).toBe('group');
    expect(card.getAttribute('aria-label')).toBe('GIF 미리보기 — 나만 보임');
  });

  // reviewer LOW-1 (S81b 리뷰): 썸네일 로드 실패 시 인라인 폴백으로 깨진 img 를 숨긴다.
  it('썸네일 onError 시 인라인 안내로 폴백한다', () => {
    seed();
    render(<GiphyPreview workspaceId={WS} channelId={CH} onSend={() => {}} />);
    fireEvent.error(screen.getByTestId('giphy-preview-image'));
    expect(screen.queryByTestId('giphy-preview-image')).toBeNull();
    expect(screen.getByTestId('giphy-preview-thumb-error')).toBeTruthy();
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
