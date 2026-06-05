import { useEffect } from 'react';
import { useSendMessage } from '../useMessages';
import { announce } from '../../../lib/a11y-announce';
import { GiphyPreview } from './GiphyPreview';
import { useGiphyPreviewStore } from './useGiphyPreview';

/**
 * S81b (D15 / FR-SC-07) — /giphy 프리뷰 마운트 슬롯(MessageColumn 하단·EphemeralList 위).
 *
 * GiphyPreview 의 Send 액션이 기존 메시지 전송 경로(useSendMessage)를 재사용해 gifUrl 을 일반
 * 메시지로 채널에 게시한다(게시된 URL 은 S60 unfurl 이 인라인 렌더). 채널 전환/언마운트 시
 * 해당 채널의 프리뷰를 정리한다(발신자 전용·비영속 — 다른 채널 잔류 방지).
 *
 * workspaceId 는 호출부(MessageColumn)가 non-null 일 때만 마운트한다(Global DM 은 /giphy 실행
 * 자체가 비활성이라 프리뷰가 생기지 않는다).
 */
export function GiphyPreviewSlot({
  workspaceId,
  channelId,
}: {
  workspaceId: string;
  channelId: string;
}): JSX.Element | null {
  const { send } = useSendMessage(workspaceId, channelId);
  // reviewer HIGH-1 (S81b 리뷰): store 액션을 직접 안정 참조로 구독한다(EphemeralList 패턴).
  // 종전엔 useGiphyPreview(channelId) 가 매 렌더 새 clear 클로저를 만들어, [channelId, clear]
  // 의존성이 매 렌더 바뀌고 cleanup 이 재실행돼 GIF 로드/Shuffle 직후 프리뷰가 즉시 삭제됐다.
  const clear = useGiphyPreviewStore((s) => s.clear);

  // 채널 전환/언마운트 시 이 채널의 GIF 프리뷰를 정리한다.
  useEffect(() => {
    return () => clear(channelId);
  }, [channelId, clear]);

  return (
    <GiphyPreview
      workspaceId={workspaceId}
      channelId={channelId}
      onSend={(gifUrl) => send(gifUrl)}
      announce={announce}
    />
  );
}
