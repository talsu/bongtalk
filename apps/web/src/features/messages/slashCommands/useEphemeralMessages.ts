import { create } from 'zustand';

/**
 * S80 (D15 / FR-SC-05) — 채널별 EPHEMERAL 슬래시 응답(발신자 전용 인라인 시스템 메시지).
 *
 * `/away`·`/dnd`·`/status`·`/remind` 등 INTERNAL_ACTION 커맨드는 채널에 게시되지 않고
 * 발신자에게만 인라인으로 확인/에러를 보여준다. 서버는 HTTP 동기 응답으로 content 를 주고,
 * FE 는 이 스토어에 채널별로 쌓아 MessageColumn 하단에 렌더한다.
 *
 * 채널 전환 시 정리(clearChannel) — 다른 채널의 ephemeral 잔류를 막는다(개인 전용·비영속).
 */
export type EphemeralMessage = {
  id: string;
  channelId: string;
  content: string;
  error: boolean;
  createdAt: number;
};

type EphemeralState = {
  byChannel: Record<string, EphemeralMessage[]>;
  push: (msg: Omit<EphemeralMessage, 'id' | 'createdAt'>) => void;
  dismiss: (channelId: string, id: string) => void;
  clearChannel: (channelId: string) => void;
};

let counter = 0;
function nextId(): string {
  counter += 1;
  return `eph-${Date.now()}-${counter}`;
}

export const useEphemeralStore = create<EphemeralState>((set) => ({
  byChannel: {},
  push: (msg) =>
    set((s) => {
      const list = s.byChannel[msg.channelId] ?? [];
      const entry: EphemeralMessage = {
        ...msg,
        id: nextId(),
        createdAt: Date.now(),
      };
      return { byChannel: { ...s.byChannel, [msg.channelId]: [...list, entry] } };
    }),
  dismiss: (channelId, id) =>
    set((s) => {
      const list = s.byChannel[channelId];
      if (!list) return s;
      return {
        byChannel: { ...s.byChannel, [channelId]: list.filter((m) => m.id !== id) },
      };
    }),
  clearChannel: (channelId) =>
    set((s) => {
      if (!(channelId in s.byChannel)) return s;
      const { [channelId]: _drop, ...rest } = s.byChannel;
      void _drop;
      return { byChannel: rest };
    }),
}));

/**
 * 한 채널의 EPHEMERAL 메시지 목록 + 조작 헬퍼. selector 로 해당 채널 슬라이스만 구독한다.
 */
export function useEphemeralMessages(channelId: string): {
  messages: EphemeralMessage[];
  push: (content: string, error: boolean) => void;
  dismiss: (id: string) => void;
} {
  const messages = useEphemeralStore((s) => s.byChannel[channelId] ?? EMPTY);
  const pushRaw = useEphemeralStore((s) => s.push);
  const dismissRaw = useEphemeralStore((s) => s.dismiss);
  return {
    messages,
    push: (content, error) => pushRaw({ channelId, content, error }),
    dismiss: (id) => dismissRaw(channelId, id),
  };
}

// 안정 참조(빈 배열) — selector 가 매 렌더 새 배열을 만들지 않도록 한다.
const EMPTY: EphemeralMessage[] = [];
