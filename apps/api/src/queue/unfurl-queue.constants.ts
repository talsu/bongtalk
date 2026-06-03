/**
 * S60 (D11 / FR-AM-13 · FR-RC07): 링크 unfurl BullMQ 큐 상수 단일 출처.
 *
 * 큐 이름 / 잡 옵션 / 동시성을 한 곳에서 정의해 QueueModule(registerQueue) ·
 * UnfurlQueueService(add) · UnfurlProcessor(@Processor + WorkerHost) 가 동일 문자열·
 * 정책을 참조하도록 한다(reminder / attachment-gc 큐 패턴과 일관).
 */
export const UNFURL_QUEUE = 'unfurl';

/** unfurl 잡 이름(단일 잡 타입). jobId 는 멱등 dedup 에 messageId 를 쓴다. */
export const UNFURL_JOB = 'unfurl-message';

/**
 * 동시성 상한. unfurl 은 모든 메시지 발화에서 enqueue 되는 고volume 경로다. 처리 비용은
 * 외부 HTTP fetch I/O 가 지배적(CPU 병목 없음)이라, S60 fix(perf MODERATE)로 2→4 로
 * 올려 고volume 적체를 완화한다. 외부 fetch 는 타임아웃 5s · 크기 상한이 있어 4 동시여도
 * NAS Redis/네트워크 압박은 제한적이다.
 */
export const UNFURL_CONCURRENCY = 4;

/**
 * 기본 잡 옵션. attempts:2 + 짧은 backoff(외부 사이트 일시 장애 best-effort 재시도).
 * unfurl 실패는 user-visible 영향이 거의 없으므로(카드가 안 뜰 뿐) 재시도는 보수적이다.
 * removeOnComplete/Fail 로 Redis 히스토리 적재를 제한한다.
 */
export const UNFURL_JOB_OPTS = {
  attempts: 2,
  backoff: { type: 'fixed' as const, delay: 5000 },
  removeOnComplete: 200,
  removeOnFail: 200,
} as const;

/** unfurl 잡 페이로드. Processor 가 messageId 로 DB 를 재조회한다(상태 진실원은 DB). */
export interface UnfurlJobData {
  messageId: string;
  channelId: string;
  // DM 채널은 null. 현재 unfurl 처리에는 쓰지 않지만, 추후 워크스페이스 스코프 정책
  // (예: 외부 링크 차단 토글)을 위해 페이로드에 함께 싣는다.
  workspaceId: string | null;
  // FE extractMessageUrls 와 동일 규칙으로 컨트롤러/서비스가 추출한 URL(꺾쇠/코드블록
  // 제외 · cap 3). Processor 는 이 목록만 처리한다(본문 재파싱 안 함 — 신뢰 경계 단일화).
  urls: string[];
}
