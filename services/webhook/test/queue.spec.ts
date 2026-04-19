import { describe, expect, it, vi } from 'vitest';
import { DeployQueue, type DeployJob, type Outcome } from '../src/queue';

function job(sha: string): DeployJob {
  return { sha, branch: 'main', pusher: 'tester', enqueuedAt: Date.now() };
}

describe('DeployQueue', () => {
  it('starts the first job immediately', async () => {
    const runner = vi.fn(async (): Promise<Outcome> => 'ok');
    const q = new DeployQueue(runner);
    const result = q.submit(job('aaa'));
    expect(result).toBe('started');
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
  });

  it('queues a second job while the first runs', async () => {
    let resolveFirst: () => void = () => {};
    const runner = vi.fn(
      (j: DeployJob): Promise<Outcome> =>
        j.sha === 'first'
          ? new Promise<Outcome>((r) => {
              resolveFirst = () => r('ok');
            })
          : Promise.resolve('ok'),
    );
    const q = new DeployQueue(runner);
    expect(q.submit(job('first'))).toBe('started');
    expect(q.submit(job('second'))).toBe('queued');
    resolveFirst();
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(2));
    expect(runner.mock.calls[1]![0].sha).toBe('second');
  });

  it('coalesces multiple pending jobs to the latest SHA', async () => {
    let resolveFirst: () => void = () => {};
    const runner = vi.fn(
      (j: DeployJob): Promise<Outcome> =>
        j.sha === 'first'
          ? new Promise<Outcome>((r) => {
              resolveFirst = () => r('ok');
            })
          : Promise.resolve('ok'),
    );
    const q = new DeployQueue(runner);
    q.submit(job('first'));
    expect(q.submit(job('middle'))).toBe('queued');
    expect(q.submit(job('tip'))).toBe('coalesced');
    expect(q.state().pending?.sha).toBe('tip');
    resolveFirst();
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(2));
    expect(runner.mock.calls[1]![0].sha).toBe('tip');
  });

  it('fires onSettled for every completed job with its outcome', async () => {
    const runner = vi.fn(
      async (j: DeployJob): Promise<Outcome> => (j.sha === 'ok' ? 'ok' : 'failed'),
    );
    const q = new DeployQueue(runner);
    const settled: Array<{ sha: string; outcome: Outcome }> = [];
    q.onSettled((j, o) => settled.push({ sha: j.sha, outcome: o }));
    q.submit(job('ok'));
    await vi.waitFor(() => expect(settled).toHaveLength(1));
    q.submit(job('fail'));
    await vi.waitFor(() => expect(settled).toHaveLength(2));
    expect(settled).toEqual([
      { sha: 'ok', outcome: 'ok' },
      { sha: 'fail', outcome: 'failed' },
    ]);
  });

  it('treats thrown runner errors as failed without breaking the queue', async () => {
    const runner = vi.fn(async (j: DeployJob): Promise<Outcome> => {
      if (j.sha === 'boom') throw new Error('nope');
      return 'ok';
    });
    const q = new DeployQueue(runner);
    const settled: Outcome[] = [];
    q.onSettled((_j, o) => settled.push(o));
    q.submit(job('boom'));
    await vi.waitFor(() => expect(settled).toEqual(['failed']));
    q.submit(job('next'));
    await vi.waitFor(() => expect(settled).toEqual(['failed', 'ok']));
  });
});
