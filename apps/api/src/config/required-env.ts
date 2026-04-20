/**
 * Boot-time env guards. Called from `main.ts` before NestFactory.create so
 * a misconfigured production deploy fails fast at container start rather
 * than silently serving wrong URLs (e.g. invite links pointing at
 * `http://localhost:45173`).
 */

export class RequiredEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequiredEnvError';
  }
}

/**
 * task-013-A3 (task-010-follow-4 closure): the dev-default test was a
 * Set of exact strings — `127.0.0.1`, trailing slash, or
 * `HTTP://LOCALHOST:5173` slipped through. Regex matches the pattern
 * that actually matters: scheme + loopback-ish host + optional port.
 * Trailing slash normalized out before the match.
 */
const DEV_WEB_URL_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/i;

export function assertProductionEnv(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV !== 'production') return;

  const rawWebUrl = (env.WEB_URL ?? '').trim();
  if (rawWebUrl.length === 0) {
    throw new RequiredEnvError(
      'WEB_URL must be set in NODE_ENV=production (used for invite links; otherwise they point at localhost)',
    );
  }
  // Normalize: lowercase + strip single trailing slash before matching.
  const normalized = rawWebUrl.toLowerCase().replace(/\/$/, '');
  if (DEV_WEB_URL_PATTERN.test(normalized)) {
    throw new RequiredEnvError(
      `WEB_URL=${rawWebUrl} is a development default (localhost / 127.0.0.1). Set it to the real frontend origin (e.g. https://qufox.com) in production.`,
    );
  }
}
