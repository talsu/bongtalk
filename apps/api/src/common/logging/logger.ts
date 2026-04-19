import pino from 'pino';

// Redact anything that could leak credentials in logs.
// Keep this list in sync with docs/tasks/001-auth.md security checklist.
export const REDACT_PATHS = [
  'req.body.password',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'res.headers["set-cookie"]',
  'password',
  'passwordHash',
  'tokenHash',
  'refreshToken',
  'refreshRaw',
  '*.password',
  '*.passwordHash',
  '*.tokenHash',
  '*.refreshToken',
  '*.refreshRaw',
];

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'qufox-api' },
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  timestamp: pino.stdTimeFunctions.isoTime,
});
