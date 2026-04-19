import { describe, expect, it, vi } from 'vitest';
import { makeShellRunnerFn, type ShellRunner } from '../src/deploy';

const job = {
  sha: 'abc1234567',
  branch: 'main',
  pusher: 'alice',
  enqueuedAt: 0,
};

describe('makeShellRunnerFn', () => {
  it('spawns the configured command with DEPLOY_* env vars', async () => {
    const shell = vi.fn<ShellRunner>(async () => ({ code: 0, stdout: 'ok', stderr: '' }));
    const run = makeShellRunnerFn({
      command: ['/bin/deploy', 'arg'],
      repoPath: '/repo',
      shell,
    });
    const outcome = await run(job);
    expect(outcome).toBe('ok');
    expect(shell).toHaveBeenCalledTimes(1);
    const [cmd, args, env] = shell.mock.calls[0]!;
    expect(cmd).toBe('/bin/deploy');
    expect(args).toEqual(['arg']);
    expect(env.DEPLOY_SHA).toBe('abc1234567');
    expect(env.DEPLOY_BRANCH).toBe('main');
    expect(env.DEPLOY_PUSHER).toBe('alice');
    expect(env.REPO_PATH).toBe('/repo');
  });

  it('returns failed on non-zero exit', async () => {
    const shell: ShellRunner = async () => ({ code: 1, stdout: '', stderr: 'boom' });
    const run = makeShellRunnerFn({ command: ['/bin/deploy'], repoPath: '/repo', shell });
    expect(await run(job)).toBe('failed');
  });

  it('invokes onLog with tailed stdout/stderr', async () => {
    const long = 'x'.repeat(10_000);
    const shell: ShellRunner = async () => ({ code: 0, stdout: long, stderr: long });
    const onLog = vi.fn();
    const run = makeShellRunnerFn({
      command: ['/bin/deploy'],
      repoPath: '/repo',
      shell,
      onLog,
    });
    await run(job);
    expect(onLog).toHaveBeenCalledTimes(1);
    const payload = onLog.mock.calls[0]![0];
    expect(payload.exitCode).toBe(0);
    expect((payload.stdoutTail as string).length).toBe(4_000);
    expect((payload.stderrTail as string).length).toBe(4_000);
  });

  it('throws if command is empty', () => {
    expect(() =>
      makeShellRunnerFn({
        command: [],
        repoPath: '/repo',
        shell: async () => ({ code: 0, stdout: '', stderr: '' }),
      }),
    ).toThrow(/deploy command/);
  });
});
