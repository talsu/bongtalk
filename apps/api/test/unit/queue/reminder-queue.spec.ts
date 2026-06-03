import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReminderQueueService } from '../../../src/queue/reminder-queue.service';
import { REMINDER_FIRE_JOB } from '../../../src/queue/reminder-queue.constants';

// S53 (D10 / FR-PS-09/10): ReminderQueueService schedule/cancel 단위 테스트.
// BullMQ Queue 는 vi.fn() 으로 모킹한다(외부 모킹 라이브러리 금지 — harness 규칙).

function makeQueueStub() {
  return {
    add: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  };
}

describe('ReminderQueueService', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  });

  it('schedule 은 기존 잡 remove 후 jobId=savedMessageId 로 add (멱등 dedup)', async () => {
    const queue = makeQueueStub();
    const svc = new ReminderQueueService(queue as never);
    const now = new Date('2025-01-01T00:00:00Z');
    const reminderAt = new Date('2025-01-01T00:01:00Z'); // 60s 후
    await svc.schedule({ savedMessageId: 'sm-1', userId: 'u-1', reminderAt, now });

    expect(queue.remove).toHaveBeenCalledWith('sm-1');
    expect(queue.add).toHaveBeenCalledTimes(1);
    const [jobName, data, opts] = queue.add.mock.calls[0];
    expect(jobName).toBe(REMINDER_FIRE_JOB);
    expect(data).toEqual({ savedMessageId: 'sm-1', userId: 'u-1' });
    expect(opts.jobId).toBe('sm-1');
    expect(opts.delay).toBe(60_000);
    expect(opts.attempts).toBe(3);
  });

  it('과거 시각 reminderAt 은 delay=0 으로 즉시 발화 큐잉', async () => {
    const queue = makeQueueStub();
    const svc = new ReminderQueueService(queue as never);
    const now = new Date('2025-01-01T00:05:00Z');
    const reminderAt = new Date('2025-01-01T00:00:00Z'); // 과거
    await svc.schedule({ savedMessageId: 'sm-2', userId: 'u-1', reminderAt, now });
    expect(queue.add.mock.calls[0][2].delay).toBe(0);
  });

  it('cancel 은 jobId(savedMessageId)로 remove', async () => {
    const queue = makeQueueStub();
    const svc = new ReminderQueueService(queue as never);
    await svc.cancel('sm-3');
    expect(queue.remove).toHaveBeenCalledWith('sm-3');
  });

  it('add 실패는 throw 하지 않는다(best-effort)', async () => {
    const queue = makeQueueStub();
    queue.add.mockRejectedValueOnce(new Error('redis down'));
    const svc = new ReminderQueueService(queue as never);
    await expect(
      svc.schedule({
        savedMessageId: 'sm-4',
        userId: 'u-1',
        reminderAt: new Date('2025-01-01T01:00:00Z'),
        now: new Date('2025-01-01T00:00:00Z'),
      }),
    ).resolves.toBeUndefined();
  });

  it('cancel 실패는 throw 하지 않는다(best-effort)', async () => {
    const queue = makeQueueStub();
    queue.remove.mockRejectedValueOnce(new Error('redis down'));
    const svc = new ReminderQueueService(queue as never);
    await expect(svc.cancel('sm-5')).resolves.toBeUndefined();
  });
});
