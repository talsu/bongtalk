import { spawn } from 'node:child_process';
import type { DeployJob, Outcome, Runner } from './queue';

export interface ShellRunner {
  (
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ): Promise<{
    code: number;
    stdout: string;
    stderr: string;
  }>;
}

export const realShellRunner: ShellRunner = (command, args, env) =>
  new Promise((resolve) => {
    const child = spawn(command, [...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += c.toString();
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString();
    });
    child.on('error', (err) => {
      resolve({ code: 127, stdout, stderr: stderr + String(err) });
    });
    child.on('close', (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });

export function makeShellRunnerFn(opts: {
  command: readonly string[];
  repoPath: string;
  shell?: ShellRunner;
  onLog?: (payload: Record<string, unknown>) => Promise<void> | void;
}): Runner {
  const shell = opts.shell ?? realShellRunner;
  const [cmd, ...args] = opts.command;
  if (!cmd) {
    throw new Error('deploy command must have at least one argument');
  }
  return async (job: DeployJob): Promise<Outcome> => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DEPLOY_SHA: job.sha,
      DEPLOY_BRANCH: job.branch,
      DEPLOY_PUSHER: job.pusher,
      REPO_PATH: opts.repoPath,
    };
    const result = await shell(cmd, args, env);
    const outcome: Outcome = result.code === 0 ? 'ok' : 'failed';
    if (opts.onLog) {
      await opts.onLog({
        sha: job.sha,
        branch: job.branch,
        pusher: job.pusher,
        exitCode: result.code,
        stdoutTail: result.stdout.slice(-4_000),
        stderrTail: result.stderr.slice(-4_000),
      });
    }
    return outcome;
  };
}
