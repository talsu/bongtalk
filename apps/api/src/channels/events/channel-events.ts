export const CHANNEL_CREATED = 'channel.created';
export const CHANNEL_UPDATED = 'channel.updated';
export const CHANNEL_DELETED = 'channel.deleted';
export const CHANNEL_RESTORED = 'channel.restored';
export const CHANNEL_ARCHIVED = 'channel.archived';
export const CHANNEL_UNARCHIVED = 'channel.unarchived';
export const CHANNEL_MOVED = 'channel.moved';
// S14 (FR-CH-11): per-channel permission override 변경(USER/ROLE 프린시펄).
// S12 의 USER override upsert 가 던지던 'channel.permission.changed' 와 동일한
// 이름을 단일 출처로 끌어올린다. ROLE override 도 같은 이벤트로 발행한다.
export const CHANNEL_PERMISSION_CHANGED = 'channel.permission.changed';
// S14 (FR-CH-07): 채널 가입/탈퇴. 공개 채널 자유 가입 + 비공개 초대 기반 가입은
// member_added 로, 탈퇴는 member_removed 로 발행한다. WS 프로젝션이 대상
// 사용자의 채널 목록/사이드바를 갱신할 수 있도록 한다.
export const CHANNEL_MEMBER_ADDED = 'channel.member_added';
export const CHANNEL_MEMBER_REMOVED = 'channel.member_removed';
export const CATEGORY_CREATED = 'category.created';
export const CATEGORY_UPDATED = 'category.updated';
export const CATEGORY_DELETED = 'category.deleted';
export const CATEGORY_MOVED = 'category.moved';
// S15 (FR-CH-13): 배치 재정렬/재정규화 후 전체 position 목록을 브로드캐스트한다.
// 단건 move 의 channel.moved 와 달리, 재정규화가 다수 행의 position 을 동시에
// 바꾸므로 클라이언트가 한 번에 동기화할 수 있도록 전체 목록을 싣는다.
// review S15 BLOCKER fix: **단수** 네임스페이스(channel./category.) 사용 — outbox→WS
// 구독자가 `@OnEvent('channel.**')`/`'category.**'` 로 받는다. 이전 복수형
// 'channels.reordered'/'categories.reordered' 는 EventEmitter2 delimiter wildcard
// (첫 토큰 정확매치)에서 어디에도 매치되지 않아 fanout 이 무음 드롭됐다.
export const CHANNEL_REORDERED = 'channel.reordered';
export const CATEGORY_REORDERED = 'category.reordered';
// S16 (FR-DM-16): 새 DM·그룹 DM 개설 시 발행. outbox→WS 구독자가 envelope.recipients
// 의 각 user:{userId} 룸으로 `dm:created` 와이어 이벤트를 fanout 한다. 단수
// 네임스페이스(dm.) 사용 — EventEmitter2 delimiter wildcard(`dm.**`) 매치를 보장한다.
export const DM_CREATED = 'dm.created';
