import { describe, expect, it } from 'vitest';
import {
  REMIND_JOB_ID_PREFIX,
  isRemindJobData,
  isRemindJobId,
  remindJobId,
} from '../../../src/queue/reminder-queue.constants';

/**
 * S80 (D15 / FR-SC-06) — REMINDER_QUEUE jobId 접두사 분기 단위 테스트.
 *
 * /remind(Reminder 모델) 잡과 SavedMessage 리마인더 잡이 같은 큐를 공유하므로,
 * jobId 접두사(`reminder:`)와 jobData 형태(kind:'remind')로 라우팅을 구분한다.
 */
describe('remind jobId routing', () => {
  it('remindJobId 는 reminder: 접두사를 붙인다', () => {
    const id = remindJobId('33333333-3333-3333-3333-333333333333');
    expect(id).toBe(`${REMIND_JOB_ID_PREFIX}33333333-3333-3333-3333-333333333333`);
  });

  it('isRemindJobId 는 접두사로 /remind 잡을 식별한다', () => {
    expect(isRemindJobId(remindJobId('abc'))).toBe(true);
    // SavedMessage 리마인더 잡은 jobId=savedMessageId(uuid) — 접두사 없음.
    expect(isRemindJobId('44444444-4444-4444-4444-444444444444')).toBe(false);
    expect(isRemindJobId(undefined)).toBe(false);
    expect(isRemindJobId(null)).toBe(false);
  });

  it('isRemindJobData 는 jobData 형태로 분기한다', () => {
    expect(
      isRemindJobData({ kind: 'remind', reminderId: 'x', userId: 'u' }),
    ).toBe(true);
    // SavedMessage 잡 데이터(savedMessageId)는 kind 가 없으므로 false.
    expect(isRemindJobData({ savedMessageId: 's', userId: 'u' })).toBe(false);
    expect(isRemindJobData(null)).toBe(false);
    expect(isRemindJobData('remind')).toBe(false);
  });
});
