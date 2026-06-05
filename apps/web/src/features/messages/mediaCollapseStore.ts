import { create } from 'zustand';

/**
 * S81a (D15 / FR-SC-08) — 채널별 인라인 미디어 접기/펼치기 상태.
 *
 * `/collapse`·`/expand` 슬래시 커맨드(클라이언트 전용)가 현재 채널의 인라인 미디어
 * (첨부 이미지·링크 임베드)를 일괄 접거나 펼친다. 채널별로 boolean 을 두어, 메시지 미디어
 * 렌더 지점(AttachmentsList·LinkPreview)이 구독해 collapsed 면 숨긴다. 비영속(개인 세션
 * 한정 UI 상태) — 새로고침/재진입 시 기본(펼침)으로 돌아간다.
 */
type MediaCollapseState = {
  collapsedByChannel: Record<string, boolean>;
  setCollapsed: (channelId: string, collapsed: boolean) => void;
  isCollapsed: (channelId: string) => boolean;
};

export const useMediaCollapseStore = create<MediaCollapseState>((set, get) => ({
  collapsedByChannel: {},
  setCollapsed: (channelId, collapsed) =>
    set((s) => ({
      collapsedByChannel: { ...s.collapsedByChannel, [channelId]: collapsed },
    })),
  isCollapsed: (channelId) => get().collapsedByChannel[channelId] === true,
}));

/**
 * 컴포넌트가 특정 채널의 collapsed 상태를 구독하는 selector 훅. 렌더 구독을 채널 단위로
 * 좁혀 다른 채널 토글이 불필요한 재렌더를 일으키지 않게 한다.
 */
export function useChannelMediaCollapsed(channelId: string | null): boolean {
  return useMediaCollapseStore((s) =>
    channelId ? s.collapsedByChannel[channelId] === true : false,
  );
}
