/**
 * Boot-time env guards. Called from `main.ts` before NestFactory.create so
 * a misconfigured production deploy fails fast at container start rather
 * than silently serving wrong URLs (e.g. invite links pointing at
 * `http://localhost:45173`).
 */

const DEV_WEB_URL_DEFAULTS = new Set<string>(['http://localhost:45173', 'http://localhost:5173']);

export class RequiredEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequiredEnvError';
  }
}

export function assertProductionEnv(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV !== 'production') return;

  const webUrl = (env.WEB_URL ?? '').trim();
  if (webUrl.length === 0) {
    throw new RequiredEnvError(
      'WEB_URL must be set in NODE_ENV=production (used for invite links; otherwise they point at localhost)',
    );
  }
  if (DEV_WEB_URL_DEFAULTS.has(webUrl)) {
    throw new RequiredEnvError(
      `WEB_URL=${webUrl} is a development default. Set it to the real frontend origin (e.g. https://qufox.com) in production.`,
    );
  }
}
