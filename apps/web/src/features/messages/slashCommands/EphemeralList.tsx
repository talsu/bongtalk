import { useEffect } from 'react';
import { EphemeralMessage } from './EphemeralMessage';
import { useEphemeralMessages, useEphemeralStore } from './useEphemeralMessages';

/**
 * S80 (D15 / FR-SC-05) — 채널의 EPHEMERAL 슬래시 응답 목록(발신자 전용).
 *
 * MessageList 와 MessageComposer 사이에 렌더해, INTERNAL_ACTION 커맨드(/away·/dnd·
 * /status·/remind 등)의 확인/에러를 "나만 보임" 인라인 행으로 보여준다. 채널 전환 시
 * 정리한다(개인 전용·비영속 — 다른 채널 잔류 방지).
 */
export function EphemeralList({ channelId }: { channelId: string }): JSX.Element | null {
  const { messages, dismiss } = useEphemeralMessages(channelId);
  const clearChannel = useEphemeralStore((s) => s.clearChannel);

  // 채널 전환/언마운트 시 이 채널의 ephemeral 을 정리한다.
  useEffect(() => {
    return () => clearChannel(channelId);
  }, [channelId, clearChannel]);

  if (messages.length === 0) return null;
  return (
    <div
      data-testid="ephemeral-list"
      className="flex flex-col gap-1 px-[var(--s-4)] pb-1"
    >
      {messages.map((m) => (
        <EphemeralMessage key={m.id} msg={m} onDismiss={() => dismiss(m.id)} />
      ))}
    </div>
  );
}
