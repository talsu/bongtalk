/**
 * S53 (D10 / FR-PS-09/10/11): 저장 리마인더 BullMQ 큐 상수 단일 출처.
 *
 * 큐 이름 / 잡 옵션을 한 곳에서 정의해 QueueModule(registerQueue) ·
 * ReminderQueueService(add/remove) · ReminderProcessor(@Processor) 가 동일
 * 문자열·정책을 참조하도록 한다.
 */
export const REMINDER_QUEUE = 'reminder';

/** 발화 잡 이름(단일 잡 타입). jobId 는 savedMessageId 로 멱등 dedup 한다. */
export const REMINDER_FIRE_JOB = 'reminder-fire';

/**
 * 기본 잡 옵션. attempts:3 + exponential backoff 5s 로 일시적 DB/WS 실패를
 * 재시도한다. removeOnComplete/Fail 로 완료·실패 잡이 Redis 에 무한 적재되는 것을
 * 막는다(단일 노드 · 영속 큐지만 히스토리는 제한).
 */
export const REMINDER_JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 },
  removeOnComplete: 1000,
  removeOnFail: 1000,
} as const;

/** 발화 잡 페이로드(잡 data). Processor 가 savedMessageId 로 DB 재조회한다. */
export interface ReminderJobData {
  savedMessageId: string;
  userId: string;
}

/**
 * S80 (D15 / FR-SC-06): /remind 리마인더 발화 잡 페이로드. SavedMessage 리마인더와 같은
 * REMINDER_QUEUE 를 공유하되, jobId 접두사(`reminder:{reminderId}`) + jobData 형태로
 * 구분한다(ReminderProcessor 가 라우팅 분기). `kind` 판별 필드로 ReminderJobData(SavedMessage)
 * 와 명시 구분한다(접두사 + 형태 이중 판별).
 */
export interface RemindJobData {
  kind: 'remind';
  reminderId: string;
  userId: string;
}

/** /remind 잡 id 접두사. SavedMessage 리마인더(jobId=savedMessageId uuid)와 구분한다. */
export const REMIND_JOB_ID_PREFIX = 'reminder:';

/** reminderId → BullMQ jobId(`reminder:{reminderId}`). */
export function remindJobId(reminderId: string): string {
  return `${REMIND_JOB_ID_PREFIX}${reminderId}`;
}

/** jobId 가 /remind(Reminder 모델) 잡인지 판정(접두사 기준). false 면 SavedMessage 잡. */
export function isRemindJobId(jobId: string | undefined | null): boolean {
  return typeof jobId === 'string' && jobId.startsWith(REMIND_JOB_ID_PREFIX);
}

/** jobData 가 RemindJobData(/remind) 인지 형태로 판정(접두사와 이중 판별). */
export function isRemindJobData(data: unknown): data is RemindJobData {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { kind?: unknown }).kind === 'remind' &&
    typeof (data as { reminderId?: unknown }).reminderId === 'string'
  );
}
