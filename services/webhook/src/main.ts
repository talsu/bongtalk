import { AuditLog } from './audit';
import { loadConfig } from './config';
import { makeShellRunnerFn } from './deploy';
import { noopNotifier, slackNotifier } from './notify';
import { DeployQueue } from './queue';
import { createWebhookServer } from './server';

function main(): void {
  const config = loadConfig();
  const audit = new AuditLog(config.auditPath);
  const notifier = config.slackUrl ? slackNotifier(config.slackUrl) : noopNotifier;

  const runner = makeShellRunnerFn({
    command: config.deployCommand,
    repoPath: config.repoPath,
    onLog: (payload) => audit.append('deploy.result', payload),
  });

  const queue = new DeployQueue(runner);
  queue.onSettled((job, outcome) => {
    const emoji = outcome === 'ok' ? '✅' : '❌';
    void notifier.send(
      `${emoji} deploy ${outcome} — ${job.branch}@${job.sha.slice(0, 7)} by ${job.pusher}`,
    );
  });

  const server = createWebhookServer({
    secret: config.secret,
    branchAllowlist: config.branchAllowlist,
    queue,
    audit,
    notifier,
  });

  server.listen(config.port, '0.0.0.0', () => {
    process.stdout.write(
      `[webhook] listening on :${config.port} (branches=${config.branchAllowlist.join(',')})\n`,
    );
  });

  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => {
      process.stdout.write(`[webhook] ${sig} — draining\n`);
      server.close(() => process.exit(0));
      // Hard stop after 30s even if a deploy is mid-flight; the shell
      // script runs in its own process tree and continues regardless.
      setTimeout(() => process.exit(1), 30_000).unref();
    });
  }
}

main();
