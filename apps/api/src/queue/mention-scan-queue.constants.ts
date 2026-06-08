/**
 * FR-MN-10 (Task 066 / S93): 키워드 알림 스캔 async 큐 상수 단일 출처(mention-broadcast 미러).
 *
 * 큐 이름 / 잡 이름 / 잡 옵션 / 동시성을 한 곳에서 정의해 QueueModule(registerQueue) ·
 * MentionScanQueueService(add) · MentionScanProcessor(@Processor + WorkerHost)가 동일
 * 문자열·정책을 참조하게 한다(mention-broadcast 패턴과 일관).
 *
 * 라우팅: messages.service send() 가 tx 커밋 후, **루트 메시지**(parentMessageId===null ·
 * 스레드 댓글 제외 · PRD)이며 워크스페이스 채널(workspaceId!==null · DM 제외)일 때 메시지당
 * 1잡으로 enqueue 한다. 워커는 잡 시점 watcher(UserSettings.keywords 보유자) 후보를 스캔 →
 * 어절 정확 일치 → VIEW_CHANNEL 가시성 → 멘션 게이트 → MentionRecord 멱등 upsert(KEYWORD) →
 * 신규 삽입분만 mention.received outbox 1건(keyword:true). 그 다음은 기존 outbox-to-ws
 * subscriber 가 WS/badge/push/replay 를 @user 와 동일하게 처리한다(이중경로 회피).
 */
export const MENTION_SCAN_QUEUE = 'mention-scan';

/** mention-scan 잡 이름(단일 잡 타입). jobId 는 멱등 dedup 에 messageId 를 쓴다. */
export const MENTION_SCAN_JOB = 'scan-keyword';

/**
 * 동시성 상한(mention-broadcast 와 동일 10). 워커 처리 비용은 DB I/O(watcher 후보 raw
 * 쿼리 + VIEW_CHANNEL 재검증 + 게이트 + MentionRecord upsert + outbox)가 지배적이라, NAS
 * Postgres 압박을 제한하면서도 키워드 fanout 처리율을 맞추는 균형값이다.
 */
export const MENTION_SCAN_CONCURRENCY = 10;

/**
 * 큐 전역 throughput 제한(mention-broadcast 와 동일 100 jobs/s). concurrency(동시 10)와
 * 별개로 BullMQ Worker limiter 가 1초당 처리 잡 수를 100 으로 묶어, 대량 메시지 burst 가
 * NAS Redis/Postgres 를 압박하지 않게 한다. @Processor 워커 옵션으로 전달한다(BullMQ 의
 * rate-limit 은 Worker 레벨 설정 — RegisterQueueOptions 에는 없음).
 */
export const MENTION_SCAN_LIMITER = { max: 100, duration: 1000 } as const;

/**
 * 기본 잡 옵션(재시도 3회 지수백오프 초기 2초). MentionRecord 멱등(ON CONFLICT DO NOTHING)
 * + 신규 삽입분만 outbox 기록이라, retry 시 재처리해도 행 1개·outbox 중복 0 이 보장된다.
 * removeOnComplete/Fail 로 Redis 히스토리 적재를 제한한다.
 */
export const MENTION_SCAN_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 2000 },
  removeOnComplete: 1000,
  removeOnFail: 1000,
} as const;

/**
 * 잡당 1메시지·재enqueue 멱등 jobId(mentionBroadcastJobId 와 동형 · 키워드 네임스페이스).
 * 같은 메시지 재enqueue 시 동일 jobId 로 dedup 되며, 잡 내부 MentionRecord ON CONFLICT 가
 * 처리 멱등의 최종 게이트다(jobId dedup 은 큐 적재만 줄인다).
 */
export function mentionScanJobId(messageId: string): string {
  return `mention-scan:${messageId}`;
}

/**
 * mention-scan 잡 페이로드. 워커가 잡 시점 watcher 후보를 raw 쿼리로 조회·매칭하므로,
 * enqueue 측은 라우팅 메타 + 동기 경로가 이미 알림한 수신자 집합(syncNotifiedUserIds)만
 * 싣는다(watcher 확장·매칭은 워커가 잡 시점 DB 권위로 수행 — 키워드 후속 변경 대비).
 */
export interface MentionScanJobData {
  /** 키워드 스캔 대상 메시지 id(MentionRecord.messageId · outbox messageId). */
  messageId: string;
  /** 메시지 채널 id(VIEW_CHANNEL 재검증 · MentionRecord.channelId · 라우팅). */
  channelId: string;
  /** 워크스페이스 id(watcher 멤버십 JOIN · MentionRecord.workspaceId). 키워드 스캔은 항상 non-null. */
  workspaceId: string;
  /** 메시지 작성자 userId(self watcher 제외 · outbox actorId · block 양방향 게이트 기준). */
  actorId: string;
  /** mention.received outbox 의 snippet(작성 시점 본문 미리보기). */
  snippet: string;
  /** 메시지 작성 시각(ISO · outbox createdAt). */
  createdAt: string;
  /**
   * 동기 send 경로(@user 직접 멘션 ∪ @everyone/@here/@channel broad)가 이미 mention.received
   * 를 발송 완료한 게이트-통과 전체 수신자 집합. 워커는 watcher 매칭에서 이 집합을 제외해,
   * 이미 멘션으로 알림받은 사용자에게 키워드 record 를 이중 생성하지 않는다(1수신자 1 Inbox).
   */
  syncNotifiedUserIds: string[];
}
