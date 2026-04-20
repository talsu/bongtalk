export interface WebhookConfig {
  secret: string;
  branchAllowlist: readonly string[];
  port: number;
  repoPath: string;
  slackUrl: string | undefined;
  auditPath: string;
  deployCommand: readonly string[];
}

function required(name: string, value: string | undefined): string {
  if (!value || value.trim().length === 0) {
    throw new Error(`webhook env missing: ${name}`);
  }
  return value.trim();
}

function parseList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parsePort(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`webhook env WEBHOOK_PORT invalid: ${raw ?? '<unset>'}`);
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WebhookConfig {
  const repoPath = required('REPO_PATH', env.REPO_PATH);
  const allowlist = parseList(env.DEPLOY_BRANCH_ALLOWLIST);
  if (allowlist.length === 0) {
    throw new Error('webhook env DEPLOY_BRANCH_ALLOWLIST must list at least one branch');
  }
  return {
    secret: required('GITHUB_WEBHOOK_SECRET', env.GITHUB_WEBHOOK_SECRET),
    branchAllowlist: allowlist,
    port: parsePort(env.WEBHOOK_PORT),
    repoPath,
    slackUrl:
      typeof env.SLACK_WEBHOOK_URL === 'string' && env.SLACK_WEBHOOK_URL.length > 0
        ? env.SLACK_WEBHOOK_URL
        : undefined,
    auditPath: env.WEBHOOK_AUDIT_PATH ?? `${repoPath}/.deploy/audit.jsonl`,
    deployCommand: [`${repoPath}/scripts/deploy/auto-deploy.sh`],
  };
}
