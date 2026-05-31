import { create } from 'zustand';

/**
 * S09 (FR-RT-22 보조): 채널별 lastReadMessageId 읽기-상태 스토어.
 *
 * LRU 로 evict 된 채널을 재진입할 때 메시지 목록을 `around=lastReadMessageId`
 * 로 재로드하기 위한 출처입니다. 서버는 connect 직후 `channel.joined`
 * WS 페이로드(events.ts ChannelJoinedPayload.lastReadMessageId)로 이 값을
 * 내려주며, dispatcher 가 수신 시 이 스토어에 기록합니다. 값이 없으면
 * (null) 호출부는 around 없이 최신 로드로 폴백합니다(과설계 방지).
 */
type ReadStateState = {
  /** channelId → 마지막으로 읽은 메시지 id(없으면 미보유). */
  lastReadByChannel: Record<string, string>;
  setLastRead: (channelId: string, messageId: string | null) => void;
  getLastRead: (channelId: string) => string | null;
};

export const useReadState = create<ReadStateState>((set, get) => ({
  lastReadByChannel: {},
  setLastRead: (channelId, messageId) =>
    set((s) => {
      if (messageId === null) {
        if (!(channelId in s.lastReadByChannel)) return s;
        const next = { ...s.lastReadByChannel };
        delete next[channelId];
        return { lastReadByChannel: next };
      }
      if (s.lastReadByChannel[channelId] === messageId) return s;
      return { lastReadByChannel: { ...s.lastReadByChannel, [channelId]: messageId } };
    }),
  getLastRead: (channelId) => get().lastReadByChannel[channelId] ?? null,
}));
