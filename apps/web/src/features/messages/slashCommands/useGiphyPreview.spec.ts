import { beforeEach, describe, expect, it } from 'vitest';
import { useGiphyPreviewStore } from './useGiphyPreview';

/**
 * S81b (D15 / FR-SC-07) — 채널별 GIPHY 프리뷰 스토어 단위 테스트.
 */
function preview(channelId: string, offset = 0) {
  return {
    channelId,
    gifUrl: `https://media.giphy.com/media/${channelId}/giphy.gif`,
    gifThumbUrl: `https://media.giphy.com/media/${channelId}/200w.gif`,
    title: 't',
    keyword: 'cat',
    offset,
  };
}

describe('useGiphyPreviewStore', () => {
  beforeEach(() => {
    useGiphyPreviewStore.setState({ byChannel: {} });
  });

  it('채널별로 단일 프리뷰를 둔다(새 set 은 대체)', () => {
    const { set } = useGiphyPreviewStore.getState();
    set(preview('c1', 0));
    set(preview('c1', 3));
    expect(useGiphyPreviewStore.getState().byChannel['c1'].offset).toBe(3);
  });

  it('clear 는 해당 채널만 정리한다(다른 채널 보존)', () => {
    const { set, clear } = useGiphyPreviewStore.getState();
    set(preview('c1'));
    set(preview('c2'));
    clear('c1');
    const state = useGiphyPreviewStore.getState().byChannel;
    expect(state['c1']).toBeUndefined();
    expect(state['c2']).toBeDefined();
  });
});
