/**
 * S88b (ADR B4 / FR-MN-19 · FR-MN-03): @role 멘션 async fanout BullMQ 큐 상수 단일 출처.
 *
 * 큐 이름 / 잡 이름 / 잡 옵션 / 동시성을 한 곳에서 정의해 QueueModule(registerQueue) ·
 * MentionBroadcastQueueService(add) · MentionBroadcastProcessor(@Processor + WorkerHost) 가
 * 동일 문자열·정책을 참조하도록 한다(reminder / unfurl 큐 패턴과 일관).
 *
 * 라우팅(B2): messages.service 가 `@<RoleName>` 멘션의 게이트 통과 roleId 집합을 메시지당
 * 1잡으로 enqueue 한다(@user/@everyone/@here/@channel 은 S88a 동기 outbox 유지·불변).
 * 워커는 잡 시점 MemberRole 로 expand → VIEW_CHANNEL 재검증 → MentionRecord 멱등 upsert →
 * 신규 삽입분만 mention.received outbox 1건. 그 다음은 기존 outbox-to-ws subscriber 가
 * WS/badge/push/replay 를 @user 와 동일하게 처리한다(이중경로 회피·B1).
 */
export const MENTION_BROADCAST_QUEUE = 'mention-broadcast';

/** mention-broadcast 잡 이름(단일 잡 타입). jobId 는 멱등 dedup 에 messageId 를 쓴다. */
export const MENTION_BROADCAST_JOB = 'broadcast-mention';

/**
 * 동시성 상한(FR-MN-19: concurrency 10). 워커 처리 비용은 DB I/O(MemberRole expand +
 * per-member VIEW_CHANNEL 재검증 + MentionRecord upsert + outbox)가 지배적이라, NAS
 * Postgres 압박을 제한하면서도 @here/@role fanout SLO 를 맞추는 균형값이다.
 */
export const MENTION_BROADCAST_CONCURRENCY = 10;

/**
 * 큐 전역 throughput 제한(FR-MN-19: rate-limit 100 jobs/s). concurrency(동시 처리 10)와
 * 별개로 BullMQ Worker limiter 가 1초당 처리 잡 수를 100 으로 묶어, 대규모 역할 멘션 burst
 * 가 NAS Redis/Postgres 를 압박하지 않게 한다. @Processor 워커 옵션으로 전달한다(BullMQ 의
 * rate-limit 은 Worker 레벨 설정 — RegisterQueueOptions 에는 없음).
 */
export const MENTION_BROADCAST_LIMITER = { max: 100, duration: 1000 } as const;

/**
 * 기본 잡 옵션(FR-MN-19: 재시도 3회 지수백오프 초기 2초). MentionRecord 멱등(ON CONFLICT
 * DO NOTHING) + 신규 삽입분만 outbox 기록이라, retry 시 재처리해도 행 1개·outbox 중복 0 이
 * 보장된다. removeOnComplete/Fail 로 Redis 히스토리 적재를 제한한다.
 */
export const MENTION_BROADCAST_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 2000 },
  removeOnComplete: 1000,
  removeOnFail: 1000,
} as const;

/**
 * 잡당 1메시지·재enqueue 멱등 jobId. PRD 의 `mention:{messageId}:{targetId}` 는 per-target
 * 잡 전제지만, 우리는 per-message 잡 1건 + MentionRecord per-target ON CONFLICT 로 동일
 * 멱등을 더 적은 잡 수로 보증한다(B2 deviation · 문서화). 같은 메시지 재enqueue 시 동일
 * jobId 로 dedup 된다.
 */
export function mentionBroadcastJobId(messageId: string): string {
  return `mention:${messageId}`;
}

/**
 * mention-broadcast 잡 페이로드. 워커가 잡 시점에 MemberRole 로 expand + VIEW_CHANNEL
 * 재검증을 수행하므로, enqueue 측은 게이트 통과 roleId 집합과 라우팅 메타만 싣는다(수신자
 * 확장은 워커가 잡 시점 DB 권위로 수행 — 권한 후속 철회 대비).
 */
export interface MentionBroadcastJobData {
  /** 멘션이 발생한 메시지 id(MentionRecord.messageId · outbox messageId). */
  messageId: string;
  /** 메시지 채널 id(VIEW_CHANNEL 재검증 · MentionRecord.channelId · 라우팅). */
  channelId: string;
  /** 워크스페이스 id(역할 네임스페이스 · MentionRecord.workspaceId). @role 은 항상 non-null. */
  workspaceId: string;
  /** 메시지 작성자 userId(self 제외 · outbox actorId). */
  actorId: string;
  /** S88a send 시점 게이트(mentionable/MENTION_EVERYONE)를 통과한 역할 id 집합. */
  gatedRoleIds: string[];
  /**
   * S88b cross-path dedup(★correctness): send 동기 경로가 직접 `@user` 로 이미 mention.received
   * 를 1건 발송 완료한 수신자 집합(저장 mentions.users). 워커는 역할 멤버 expand 후 이 집합을
   * 제외해, @user ∪ @role 양쪽에 걸린 수신자가 동기(@user)+async(@role) 로 2건 받지 않도록
   * 한다(S88a union-dedup 의미 복원 · 1수신자 정확히 1건). enqueue 시점에 mentions.users 를
   * 싣어 워커의 메시지 재조회를 피한다(이미 send tx 에서 mentions JSONB 로 저장됨).
   */
  mentionedUserIds: string[];
  /** mention.received outbox 의 snippet(작성 시점 본문 미리보기). */
  snippet: string;
  /** 본문/힌트의 @everyone 표식(outbox payload 정합). */
  everyone: boolean;
  /** 본문/힌트의 @here 표식(outbox payload 정합). */
  here: boolean;
  /** 메시지 작성 시각(ISO · outbox createdAt). */
  createdAt: string;
}
