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
  // S68 (D13 / FR-W04·W04a): 이메일 초대 rawToken/opaque 코드/초대 URL 평문 마스킹.
  // ★핵심 AC: rawToken 이 쿼리/바디로 들어와도 로그에 평문으로 남지 않게 한다(req.body.token
  // 은 accept/exchange 바디, inviteUrl/rawToken/opaqueCode 는 도메인 페이로드 키).
  'req.body.token',
  'rawToken',
  'opaqueCode',
  'inviteUrl',
  '*.rawToken',
  '*.opaqueCode',
  '*.inviteUrl',
];

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'qufox-api' },
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  timestamp: pino.stdTimeFunctions.isoTime,
});
