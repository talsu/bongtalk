/**
 * S55 (D11 / FR-AM-29): 첨부 orphan GC BullMQ 큐 상수 단일 출처.
 *
 * 큐 이름 / repeatable 패턴 / 잡 옵션을 한 곳에서 정의해 QueueModule(registerQueue) ·
 * AttachmentGcProcessor(@Processor + onModuleInit 등록) 가 동일 문자열·정책을
 * 참조하도록 한다(reminder 큐 패턴과 일관).
 */
export const ATTACHMENT_GC_QUEUE = 'attachment-gc';

/** 일일 실행 잡 이름. jobId 는 고정(GC_JOB_ID)으로 멱등 dedup. */
export const ATTACHMENT_GC_JOB = 'attachment-gc-sweep';

/**
 * repeatable 잡 고정 식별자. repeat 옵션이 동일하면 BullMQ 가 중복 등록을 스킵하지만,
 * onModuleInit 가 매 부팅마다 호출되므로 명시 jobId 로 단일 스케줄을 보장한다.
 */
export const ATTACHMENT_GC_JOB_ID = 'attachment-gc-daily';

/** cron 패턴 — 매일 04:00(UTC). 백업 윈도우와 겹치지 않는 한산한 시각. */
export const ATTACHMENT_GC_CRON = '0 4 * * *';

/** 배치 페이지 크기 — 한 번에 처리할 orphan/세션 수(메모리·tx 부담 제한). */
export const ATTACHMENT_GC_BATCH_SIZE = 500;

/** 미연결(linkedAt=null) 첨부를 orphan 으로 보는 유예(시간). */
export const ATTACHMENT_GC_UNLINKED_GRACE_HOURS = 24;

/**
 * 기본 잡 옵션. attempts:2 + 짧은 backoff(일일 잡이라 재시도는 best-effort).
 * removeOnComplete/Fail 로 히스토리 적재를 제한한다.
 */
export const ATTACHMENT_GC_JOB_OPTS = {
  attempts: 2,
  backoff: { type: 'fixed' as const, delay: 30_000 },
  removeOnComplete: 100,
  removeOnFail: 100,
} as const;
