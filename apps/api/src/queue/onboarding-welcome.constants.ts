/**
 * S71 (D13 / FR-W09): 워크스페이스 웰컴 발송 BullMQ 큐 상수 단일 출처.
 *
 * 관심사(Step2) 완료 트랜잭션이 커밋된 뒤 ApplicationsService/OnboardingService 가 이
 * 큐에 잡을 enqueue 한다(tx 커밋 후 분리 — 결정사항). Processor 가:
 *   (1) WorkspaceWelcome 행을 조회(없으면 skip — Step3 비대상).
 *   (2) welcome.message 가 있으면 신규 멤버에게 시스템 DM 을 보낸다(워크스페이스 owner ↔
 *       멤버 1:1 DM 에 owner 작성 메시지로 게시 — best-effort).
 *   (3) welcome.welcomeChannelId 가 있으면 그 채널에 SYSTEM_MEMBER_JOINED 입장 메시지를
 *       게시한다(MessagesService.createSystemMessage 재사용).
 *
 * 멱등 dedup: jobId = `welcome:{workspaceId}:{userId}`. 같은 멤버의 온보딩 재완료(멱등
 * complete)가 중복 잡을 만들지 않도록 enqueue 전 remove 한다(reminder jobId 선례). 잡 자체도
 * DM createOrGet 멱등 + 입장 메시지는 best-effort 라 1회 추가 발송돼도 치명적이지 않다.
 */
export const ONBOARDING_WELCOME_QUEUE = 'onboarding-welcome';

/** 웰컴 발송 잡 이름(단일 잡 타입). */
export const ONBOARDING_WELCOME_JOB = 'onboarding-welcome-fire';

/**
 * 기본 잡 옵션. attempts:3(DM/메시지 게시는 Redis/DB 일시 장애에 재시도 가치 — backoff
 * exponential). removeOnComplete/Fail 로 히스토리 제한.
 */
export const ONBOARDING_WELCOME_JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: 1000,
  removeOnFail: 1000,
} as const;

/** 웰컴 잡 페이로드(잡 data). Processor 가 (workspaceId, userId)로 welcome/멤버를 재조회한다. */
export interface OnboardingWelcomeJobData {
  workspaceId: string;
  userId: string;
}

/**
 * jobId 규약 — (workspaceId, userId) 당 1개. complete 재호출(멱등)이 중복 잡을 만들지 않게
 * enqueue 전 같은 jobId 를 remove 한다(reminder jobId=savedMessageId 선례).
 */
export function onboardingWelcomeJobId(workspaceId: string, userId: string): string {
  return `welcome:${workspaceId}:${userId}`;
}
