/**
 * S86 (D16 / FR-MN-15): Web Push 전송 BullMQ 큐 상수 단일 출처(reminder-queue.constants 선례).
 *
 * 큐 이름 / 잡 이름 / 잡 옵션을 한 곳에서 정의해 QueueModule(registerQueue) ·
 * PushQueueService(add) · PushProcessor(@Processor) 가 동일 문자열·정책을 참조하게 한다.
 */
export const PUSH_SEND_QUEUE = 'push-send';

/** 전송 잡 이름(단일 잡 타입). jobId 는 dedup 하지 않는다(멘션마다 독립 전송). */
export const PUSH_SEND_JOB = 'push-send';

/**
 * 기본 잡 옵션. attempts:3 + exponential backoff 5s 로 일시적 DB/push-service 실패를
 * 재시도한다(reminder 와 동일 정책). removeOnComplete/Fail 로 히스토리를 제한한다.
 */
export const PUSH_SEND_JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 },
  removeOnComplete: 1000,
  removeOnFail: 1000,
} as const;

/**
 * 전송 잡 페이로드(잡 data). Processor 가 잡 실행 시점에 DND/mute/NotifLevel 재게이트 +
 * read-check 를 수행하므로, 멘션 메타(채널/메시지/작성자/스니펫)와 발생 워크스페이스를
 * 함께 실어 잡 실행 시점 재조회 키로 쓴다.
 */
export interface PushSendJobData {
  userId: string;
  workspaceId: string | null;
  channelId: string;
  messageId: string;
  actorId: string;
  /** 알림 본문에 쓸 메시지 발췌(이미 잘린 snippet). */
  snippet: string;
  /** @everyone 으로 확장된 수신자인지(재게이트 시 broad/direct 판정). */
  everyone: boolean;
  /** @here 로 확장된 수신자인지. */
  here: boolean;
  /** 작성자 표시명(있으면 제목에 사용). 없으면 generic 카피. */
  actorName?: string;
}
