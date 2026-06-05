import { create } from 'zustand';

/**
 * S81b (D15 / FR-SC-07) — 채널별 /giphy 프리뷰(발신자 전용·비영속).
 *
 * `/giphy [키워드]` 실행이 GIPHY_PREVIEW 응답을 받으면 이 스토어에 채널별로 단일 프리뷰를
 * 올린다. EphemeralMessage 와 시각 일관되게 MessageColumn 하단(EphemeralList 위)에 렌더하되,
 * Shuffle(같은 키워드 다음 GIF)·Send(채널 게시)·Cancel(제거) 액션을 가진다. 한 채널에 하나의
 * 활성 프리뷰만 둔다(새 /giphy 실행은 기존 프리뷰를 대체). 채널 전환 시 정리한다.
 */
export type GiphyPreview = {
  channelId: string;
  gifUrl: string;
  gifThumbUrl: string;
  title: string;
  keyword: string;
  offset: number;
};

type GiphyPreviewState = {
  byChannel: Record<string, GiphyPreview>;
  set: (preview: GiphyPreview) => void;
  clear: (channelId: string) => void;
};

export const useGiphyPreviewStore = create<GiphyPreviewState>((set) => ({
  byChannel: {},
  set: (preview) => set((s) => ({ byChannel: { ...s.byChannel, [preview.channelId]: preview } })),
  clear: (channelId) =>
    set((s) => {
      if (!(channelId in s.byChannel)) return s;
      const { [channelId]: _drop, ...rest } = s.byChannel;
      void _drop;
      return { byChannel: rest };
    }),
}));

/** 한 채널의 활성 GIPHY 프리뷰 + 조작 헬퍼. */
export function useGiphyPreview(channelId: string): {
  preview: GiphyPreview | null;
  set: (preview: Omit<GiphyPreview, 'channelId'>) => void;
  clear: () => void;
} {
  const preview = useGiphyPreviewStore((s) => s.byChannel[channelId] ?? null);
  const setRaw = useGiphyPreviewStore((s) => s.set);
  const clearRaw = useGiphyPreviewStore((s) => s.clear);
  return {
    preview,
    set: (p) => setRaw({ ...p, channelId }),
    clear: () => clearRaw(channelId),
  };
}
