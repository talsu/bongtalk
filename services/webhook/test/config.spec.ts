import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

const base = {
  GITHUB_WEBHOOK_SECRET: 'a'.repeat(64),
  DEPLOY_BRANCH_ALLOWLIST: 'main',
  WEBHOOK_PORT: '9000',
  REPO_PATH: '/repo',
};

describe('loadConfig', () => {
  it('parses minimum required env', () => {
    const c = loadConfig(base);
    expect(c.port).toBe(9000);
    expect(c.branchAllowlist).toEqual(['main']);
    expect(c.slackUrl).toBeUndefined();
    expect(c.auditPath).toBe('/repo/.deploy/audit.jsonl');
    expect(c.deployCommand).toEqual(['/repo/scripts/deploy/auto-deploy.sh']);
  });

  it('parses comma-separated allowlist, trimming whitespace', () => {
    const c = loadConfig({ ...base, DEPLOY_BRANCH_ALLOWLIST: ' main, release/*, hotfix ' });
    expect(c.branchAllowlist).toEqual(['main', 'release/*', 'hotfix']);
  });

  it('reads optional slack url', () => {
    const c = loadConfig({ ...base, SLACK_WEBHOOK_URL: 'https://hooks.slack.com/x' });
    expect(c.slackUrl).toBe('https://hooks.slack.com/x');
  });

  it('throws when secret is empty', () => {
    expect(() => loadConfig({ ...base, GITHUB_WEBHOOK_SECRET: '' })).toThrow(
      /GITHUB_WEBHOOK_SECRET/,
    );
  });

  it('throws when allowlist is empty', () => {
    expect(() => loadConfig({ ...base, DEPLOY_BRANCH_ALLOWLIST: '' })).toThrow(
      /DEPLOY_BRANCH_ALLOWLIST/,
    );
  });

  it('throws when port is not a valid integer', () => {
    expect(() => loadConfig({ ...base, WEBHOOK_PORT: 'abc' })).toThrow(/WEBHOOK_PORT/);
    expect(() => loadConfig({ ...base, WEBHOOK_PORT: '70000' })).toThrow(/WEBHOOK_PORT/);
  });
});
