/**
 * 071-M3 F10 (M1 이월) — 멘션 토큰 백필 1회성 잡 상수 단일 출처.
 *
 * 배경: M1 에서 MENTION_USER_RE/MENTION_CHANNEL_RE 가 cuid2 전용이던 잠복 버그를
 * uuid|cuid2 로 수리했지만(shared-types 0.1.2), 버그 기간에 저장된 Message 행은
 * contentAst 의 멘션이 평문 text 노드(@{uuid}/<#uuid>)로 남아 멘션 pill 이
 * 깨진 채 렌더된다. 본 잡이 대상 행의 contentRaw 를 재파싱해 contentAst/
 * contentPlain 만 갱신한다(updatedAt/version/editedAt 불변 · 구값은
 * MentionBackfillBackup 에 적재 — reversible).
 *
 * 실행 모델: onModuleInit 가 고정 jobId 로 단일 잡을 enqueue(BullMQ dedup) +
 * Redis 완료 마커로 재배포 시 재실행을 차단한다 — 배포만으로 1회 실행되는
 * Safe Autonomy 정합 경로(AI 의 prod DB 직접 접근 불요).
 */
export const MENTION_BACKFILL_QUEUE = 'mention-backfill';
export const MENTION_BACKFILL_JOB = 'mention-uuid-backfill';
export const MENTION_BACKFILL_JOB_ID = 'mention-uuid-backfill-071';

/** Redis 완료 마커 — 존재하면 onModuleInit 가 enqueue 자체를 스킵한다. */
export const MENTION_BACKFILL_DONE_KEY = 'qufox:backfill:mention-uuid-071:done';

/** 트랜잭션당 처리 행 수(메모리·잠금 부담 제한). */
export const MENTION_BACKFILL_BATCH_SIZE = 200;

export const MENTION_BACKFILL_JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'fixed' as const, delay: 60_000 },
  removeOnComplete: 10,
  removeOnFail: 10,
} as const;
