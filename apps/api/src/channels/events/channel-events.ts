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
