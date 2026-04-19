import { describe, it, expect, beforeEach, vi } from 'vitest';
import pino from 'pino';
import { REDACT_PATHS } from '../../../src/common/logging/logger';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('logger redact', () => {
  it('masks password, cookie, tokenHash, refreshRaw', () => {
    const chunks: string[] = [];
    const log = pino(
      { redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } },
      pino.multistream([{ level: 'info', stream: { write: (s: string) => chunks.push(s) } }]),
    );

    log.info({
      req: { body: { password: 'Secret123!' }, headers: { cookie: 'refresh_token=xyz' } },
      tokenHash: 'abc123',
      passwordHash: '$argon2id$...',
      refreshRaw: 'raw-secret',
    });

    const out = chunks.join('');
    expect(out).not.toContain('Secret123!');
    expect(out).not.toContain('refresh_token=xyz');
    expect(out).not.toContain('abc123');
    expect(out).not.toContain('$argon2id$');
    expect(out).not.toContain('raw-secret');
    expect(out).toContain('[REDACTED]');
  });
});
