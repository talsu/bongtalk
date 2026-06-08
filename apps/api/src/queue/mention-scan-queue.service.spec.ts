import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Queue } from 'bullmq';
import { MentionScanQueueService } from './mention-scan-queue.service';
import {
  MENTION_SCAN_JOB,
  MENTION_SCAN_OPTS,
  mentionScanJobId,
  type MentionScanJobData,
} from './mention-scan-queue.constants';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

function makeQueue(opts: { addThrows?: boolean } = {}): {
  queue: Queue<MentionScanJobData>;
  add: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
} {
  const add = vi.fn(async () => {
    if (opts.addThrows) throw new Error('redis down');
    return { id: 'job-1' };
  });
  const remove = vi.fn(async () => 1);
  const queue = { add, remove } as unknown as Queue<MentionScanJobData>;
  return { queue, add, remove };
}

const baseData: MentionScanJobData = {
  messageId: 'msg-1',
  channelId: 'chan-1',
  workspaceId: 'ws-1',
  actorId: 'author-1',
  snippet: 'please deploy now',
  createdAt: '2025-01-01T00:00:00.000Z',
  syncNotifiedUserIds: [],
};

describe('FR-MN-10 mention-scan constants', () => {
  it('derives a deterministic per-message jobId', () => {
    expect(mentionScanJobId('msg-1')).toBe('mention-scan:msg-1');
    expect(mentionScanJobId('abc')).toBe('mention-scan:abc');
  });

  it('uses 3 attempts with exponential 2s backoff and bounded history', () => {
    expect(MENTION_SCAN_OPTS.attempts).toBe(3);
    expect(MENTION_SCAN_OPTS.backoff).toEqual({ type: 'exponential', delay: 2000 });
    expect(MENTION_SCAN_OPTS.removeOnComplete).toBe(1000);
    expect(MENTION_SCAN_OPTS.removeOnFail).toBe(1000);
  });
});

describe('FR-MN-10 MentionScanQueueService', () => {
  it('enqueues one job with the per-message jobId + opts (remove→add 멱등)', async () => {
    const { queue, add, remove } = makeQueue();
    const svc = new MentionScanQueueService(queue);
    await svc.enqueue(baseData);
    expect(remove).toHaveBeenCalledWith('mention-scan:msg-1');
    expect(add).toHaveBeenCalledOnce();
    const [jobName, data, opts] = add.mock.calls[0];
    expect(jobName).toBe(MENTION_SCAN_JOB);
    expect(data).toEqual(baseData);
    expect(opts).toMatchObject({ jobId: 'mention-scan:msg-1', attempts: 3 });
  });

  it('swallows Redis failures (best-effort — never throws into the send path)', async () => {
    const { queue, add } = makeQueue({ addThrows: true });
    const svc = new MentionScanQueueService(queue);
    await expect(svc.enqueue(baseData)).resolves.toBeUndefined();
    expect(add).toHaveBeenCalledOnce();
  });
});
