/**
 * S41 (FR-RC20 / FR-EM01 / FR-EM04): 워크스페이스 커스텀 이모지 라이프사이클
 * outbox 이벤트. finalize 성공 시 `emoji.created`, 삭제 성공 시 `emoji.deleted`
 * 를 발행한다. dot 컨벤션(emoji.*)을 유지해 outbox→WS subscriber 의
 * `emoji.**` 와일드카드가 워크스페이스 룸 fanout 경로에 진입하며, subscriber 가
 * 콜론 wire 이름 `emoji:created` / `emoji:deleted` 로 변환해 emit 한다
 * (reaction:updated / thread:lock:changed 선례). payload 는 워크스페이스 룸
 * 라우팅에 필요한 식별자 + 클라가 캐시 무효화/제거에 필요한 최소 필드만 담는다.
 */
export const EMOJI_CREATED = 'emoji.created';
export const EMOJI_DELETED = 'emoji.deleted';

/**
 * emoji.created payload. 수신 클라는 `['custom-emojis', workspaceId]` 쿼리를
 * invalidate 해 새 이모지를 피커/매니저에 반영한다. emoji 메타(id/name/url 등)는
 * 와이어에 동봉하되, 클라이언트는 보수적으로 invalidate 후 재조회한다(presigned
 * url 의 만료/서명 정합을 서버 list 응답에 위임).
 */
export type EmojiCreatedPayload = {
  workspaceId: string;
  emojiId: string;
  name: string;
};

/**
 * emoji.deleted payload. 수신 클라는 `['custom-emojis', workspaceId]` 캐시에서
 * 해당 emojiId 를 제거(또는 invalidate)하고, 진행 중인 메시지 반응의 placeholder
 * 전환은 다음 authoritative read 가 self-heal 한다(FR-EM06).
 */
export type EmojiDeletedPayload = {
  workspaceId: string;
  emojiId: string;
  name: string;
};
