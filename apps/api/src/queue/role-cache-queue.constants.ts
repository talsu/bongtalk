/**
 * S61 (D12 / FR-RM15): 역할 삭제 cascade 시 보유 멤버의 권한 캐시 무효화 배치 큐.
 *
 * Role 삭제 cascade(MemberRole·ChannelPermissionOverride 삭제)는 트랜잭션에서
 * 즉시 처리한다. 보유 멤버 수가 ROLE_CACHE_BATCH_THRESHOLD(1000)명 초과면 멤버별
 * Redis `perms:{channelId}:{roleId}` 캐시 DEL 을 BullMQ Job 으로 비동기 처리해
 * 요청 응답을 막지 않는다([[project_bullmq_greenlight]] · 기존 queue.module 패턴 재사용).
 *
 * ★ 정합성 보장(FR-RM14/15): 배치 처리 중에도 삭제된 역할 보유 멤버의 권한은
 *   DB(MemberRole 행 cascade 삭제 완료)로 이미 재계산되므로, 캐시 stale 여부와
 *   무관하게 SEND_MESSAGES 등은 즉시 정확해야 한다 — 권한 계산이 캐시 miss 시 DB
 *   를 읽고, 삭제 후 즉시 캐시 DEL 이 (배치라도) 뒤따르므로 stale window 가 닫힌다.
 *
 * ★ S62: read-through 배선 완료. 권한 캐시는 channel-access.service 가
 *   per-(channel, user) 키(`perms:{channelId}:{userId}`)로 GET→miss 시 계산+SET
 *   (TTL≤5초)한다. 무효화는 (1) channels.service 가 override upsert 직후
 *   `perms:{channelId}:*` SCAN+DEL, (2) 본 큐가 역할 삭제 cascade 시 영향 멤버 ×
 *   채널 조합 DEL, (3) member-role.service 가 역할 부여/회수 시 해당 멤버 키 DEL
 *   로 닫는다. 키 슬롯(`{roleId}` 인자)은 규약상 principal slot 이며 S62 부터 userId
 *   를 담는다(역할 삭제는 userIds 페이로드로 멤버별 키를 조합).
 */
export const ROLE_CACHE_QUEUE = 'role-cache';

/** 역할 캐시 무효화 잡 이름. */
export const ROLE_CACHE_INVALIDATE_JOB = 'role-cache-invalidate';

/** 멤버 수가 이 값을 초과하면 캐시 DEL 을 BullMQ 배치로 넘긴다(FR-RM15). */
export const ROLE_CACHE_BATCH_THRESHOLD = 1000;

/** 배치 잡당 처리할 멤버 캐시 키 청크 크기(Redis DEL pipeline 단위). */
export const ROLE_CACHE_BATCH_CHUNK = 500;

export const ROLE_CACHE_JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 },
  removeOnComplete: 1000,
  removeOnFail: 1000,
} as const;

/**
 * 배치 잡 페이로드. 삭제된 역할이 영향을 준 (channelId, userId) 캐시 키들을
 * 만들기 위한 최소 정보. roleId 는 삭제됐으므로 페이로드로 직접 전달한다.
 */
export interface RoleCacheJobData {
  workspaceId: string;
  roleId: string;
  /** 영향받는 멤버 userId 목록(이 역할을 보유했던 멤버). */
  userIds: string[];
  /** 워크스페이스 채널 id 목록(perms:{channelId}:{roleId} 키 조합용). */
  channelIds: string[];
}

/** S61: 역할별 권한 캐시 키. FR-RM14/15 의 `perms:{channelId}:{roleId}` 규약. */
export function roleCacheKey(channelId: string, roleId: string): string {
  return `perms:${channelId}:${roleId}`;
}
