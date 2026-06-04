/**
 * S70 (D13 / FR-W12 · Fork A-1): 임시 멤버 자동 강퇴(disconnect debounce) BullMQ 큐
 * 상수 단일 출처.
 *
 * 큐 이름 / 잡 옵션 / jobId 규약 / Redis Set 키를 한 곳에서 정의해 QueueModule
 * (registerQueue) · TempEvictQueueService(add/remove + Redis Set SADD/SREM/SCARD) ·
 * TempEvictProcessor(@Processor) 가 동일 문자열·정책을 참조하도록 한다.
 *
 * 메커니즘(멀티노드 안전):
 *   - connect 시: 해당 워크스페이스가 isTemporary 멤버십이면 Redis Set
 *     `temp-evict:sockets:{userId}:{workspaceId}` 에 socketId SADD + 기존 강퇴 잡 remove(취소).
 *   - disconnect 시: socketId SREM. SCARD 가 0 이면 BullMQ delayed job 을 add(2초 debounce).
 *   - Processor: delay 만료 후 SCARD 0 을 **재확인**(2초 내 재연결 시 set 이 비어있지 않음 →
 *     skip)하고 isTemporary 멤버면 강퇴한다. Redis Set 이 진실원이라 다중노드/다중기기에서
 *     한 노드의 disconnect 여도 다른 노드/기기 소켓이 set 에 남아있으면 SCARD>0 → 미실행.
 *
 * in-memory setTimeout 금지(CLAUDE.md stateless/멀티노드 원칙) — delay 는 BullMQ Redis
 * 영속 큐가, 활성 소켓 집계는 Redis Set 이 담당해 노드 재시작/멀티노드에 안전하다.
 */
export const TEMP_EVICT_QUEUE = 'temp-evict';

/** 강퇴 잡 이름(단일 잡 타입). */
export const TEMP_EVICT_JOB = 'temp-evict-fire';

/** FR-W12: 마지막 소켓 disconnect 후 강퇴까지의 debounce(2초). 2초 내 재연결 시 미실행. */
export const TEMP_EVICT_DEBOUNCE_MS = 2000;

/**
 * temp-evict Worker pollInterval(ms). BullMQ 기본 delayed-poll 주기는 ~1s 라 2초 debounce
 * 가 최대 ~3s 까지 늘어질 수 있다(결정 1). 250ms 로 낮춰 2초 정밀도를 확보한다(잡 수가
 * 적어 추가 부하는 무시 가능).
 */
export const TEMP_EVICT_POLL_INTERVAL_MS = 250;

/**
 * 기본 잡 옵션. attempts:1(강퇴는 멱등 — 재시도해도 같은 결과지만, SCARD 재확인이
 * 게이트라 일시 실패 재시도가 의미 없음). removeOnComplete/Fail 로 히스토리 제한.
 */
export const TEMP_EVICT_JOB_OPTS = {
  attempts: 1,
  removeOnComplete: 1000,
  removeOnFail: 1000,
} as const;

/** 강퇴 잡 페이로드(잡 data). Processor 가 (userId, workspaceId)로 SCARD/멤버십 재조회한다. */
export interface TempEvictJobData {
  userId: string;
  workspaceId: string;
}

/**
 * jobId 규약 — (userId, workspaceId) 당 1개. connect 시 remove(취소) · disconnect 시
 * add 가 같은 jobId 를 쓰므로 멱등하다(reminder jobId=savedMessageId 선례).
 */
export function tempEvictJobId(userId: string, workspaceId: string): string {
  return `temp-evict:${userId}:${workspaceId}`;
}

/**
 * Redis Set 키 — 한 사용자의 한 워크스페이스에 대한 활성 socketId 집합. keyPrefix
 * `qufox:` 는 공유 RedisModule 클라이언트가 자동으로 붙이므로 여기엔 넣지 않는다.
 */
export function tempEvictSocketsKey(userId: string, workspaceId: string): string {
  return `temp-evict:sockets:${userId}:${workspaceId}`;
}

/** Redis Set TTL(초). 노드 크래시로 SREM 이 누락돼도 stale socketId 가 영구 잔존하지 않게
 *  방어적 만료를 둔다(세션 TTL 보다 넉넉). 강퇴 정확성은 SCARD 재확인이 보장하므로 이 TTL
 *  은 leak 방어용일 뿐이다. */
export const TEMP_EVICT_SOCKETS_TTL_SEC = 60 * 60; // 1h
