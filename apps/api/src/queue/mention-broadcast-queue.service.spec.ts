import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Queue } from 'bullmq';
import { MentionBroadcastQueueService } from './mention-broadcast-queue.service';
import {
  MENTION_BROADCAST_JOB,
  MENTION_BROADCAST_OPTS,
  mentionBroadcastJobId,
  type MentionBroadcastJobData,
} from './mention-broadcast-queue.constants';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

function makeQueue(opts: { addThrows?: boolean } = {}): {
  queue: Queue<MentionBroadcastJobData>;
  add: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
} {
  const add = vi.fn(async () => {
    if (opts.addThrows) throw new Error('redis down');
    return { id: 'job-1' };
  });
  const remove = vi.fn(async () => 1);
  const queue = { add, remove } as unknown as Queue<MentionBroadcastJobData>;
  return { queue, add, remove };
}

const baseData: MentionBroadcastJobData = {
  messageId: 'msg-1',
  channelId: 'chan-1',
  workspaceId: 'ws-1',
  actorId: 'author-1',
  parentMessageId: null,
  gatedRoleIds: ['role-1', 'role-2'],
  syncNotifiedUserIds: [],
  snippet: 'hello @Designers',
  everyone: false,
  here: false,
  createdAt: '2025-01-01T00:00:00.000Z',
};

describe('S88b mention-broadcast constants', () => {
  it('derives a deterministic per-message jobId', () => {
    expect(mentionBroadcastJobId('msg-1')).toBe('mention:msg-1');
    expect(mentionBroadcastJobId('abc')).toBe('mention:abc');
  });

  it('uses 3 attempts with exponential 2s backoff and bounded history', () => {
    expect(MENTION_BROADCAST_OPTS.attempts).toBe(3);
    expect(MENTION_BROADCAST_OPTS.backoff).toEqual({ type: 'exponential', delay: 2000 });
    expect(MENTION_BROADCAST_OPTS.removeOnComplete).toBe(1000);
    expect(MENTION_BROADCAST_OPTS.removeOnFail).toBe(1000);
  });
});

describe('S88b MentionBroadcastQueueService (FR-MN-19)', () => {
  it('enqueues one job with the per-message jobId + opts', async () => {
    const { queue, add, remove } = makeQueue();
    const svc = new MentionBroadcastQueueService(queue);
    await svc.enqueue(baseData);
    // 멱등: 기존 잡 remove 후 동일 jobId 로 add.
    expect(remove).toHaveBeenCalledWith('mention:msg-1');
    expect(add).toHaveBeenCalledOnce();
    const [jobName, data, opts] = add.mock.calls[0];
    expect(jobName).toBe(MENTION_BROADCAST_JOB);
    expect(data).toEqual(baseData);
    expect(opts).toMatchObject({ jobId: 'mention:msg-1', attempts: 3 });
  });

  it('is a no-op when no roles passed the gate (no Redis round-trip)', async () => {
    const { queue, add, remove } = makeQueue();
    const svc = new MentionBroadcastQueueService(queue);
    await svc.enqueue({ ...baseData, gatedRoleIds: [] });
    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('swallows Redis failures (best-effort — never throws into the send path)', async () => {
    const { queue, add } = makeQueue({ addThrows: true });
    const svc = new MentionBroadcastQueueService(queue);
    await expect(svc.enqueue(baseData)).resolves.toBeUndefined();
    expect(add).toHaveBeenCalledOnce();
  });
});
