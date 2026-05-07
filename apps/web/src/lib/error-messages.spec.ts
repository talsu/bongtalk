import { describe, it, expect } from 'vitest';
import { friendlyError, RECOVERY_LABEL } from './error-messages';

/**
 * task-046 iter7 (P2/P3): consolidated error message + recovery action 검증.
 */

describe('friendlyError (task-046 P2/P3)', () => {
  it('errorCode AUTH_INVALID_TOKEN → 한국어 + login recovery', () => {
    const err = Object.assign(new Error('Token expired'), {
      errorCode: 'AUTH_INVALID_TOKEN',
      status: 401,
    });
    const r = friendlyError(err);
    expect(r.message).toMatch(/세션이 만료/);
    expect(r.recovery).toBe('login');
    expect(r.errorCode).toBe('AUTH_INVALID_TOKEN');
    expect(r.status).toBe(401);
  });

  it('errorCode RATE_LIMIT_EXCEEDED → retry recovery', () => {
    const err = Object.assign(new Error('rate limit'), {
      errorCode: 'RATE_LIMIT_EXCEEDED',
      status: 429,
    });
    const r = friendlyError(err);
    expect(r.recovery).toBe('retry');
    expect(r.message).toMatch(/잠시 후/);
  });

  it('errorCode VALIDATION_FAILED → 입력 확인 메시지', () => {
    const err = Object.assign(new Error('validation'), {
      errorCode: 'VALIDATION_FAILED',
      status: 400,
    });
    const r = friendlyError(err);
    expect(r.message).toMatch(/입력값/);
    expect(r.recovery).toBe('none');
  });

  it('errorCode CHANNEL_NOT_FOUND → refresh recovery', () => {
    const err = Object.assign(new Error('not found'), {
      errorCode: 'CHANNEL_NOT_FOUND',
      status: 404,
    });
    const r = friendlyError(err);
    expect(r.recovery).toBe('refresh');
    expect(r.message).toMatch(/채널을 찾을 수 없/);
  });

  it('errorCode 가 없으면 status 기반 fallback (500 → retry)', () => {
    const err = Object.assign(new Error('boom'), { status: 500 });
    const r = friendlyError(err);
    expect(r.recovery).toBe('retry');
    expect(r.message).toMatch(/서버 오류/);
  });

  it('status 401 fallback → login', () => {
    const err = Object.assign(new Error('unauth'), { status: 401 });
    const r = friendlyError(err);
    expect(r.recovery).toBe('login');
  });

  it('status 403 fallback → none (권한 없음)', () => {
    const err = Object.assign(new Error('forbidden'), { status: 403 });
    const r = friendlyError(err);
    expect(r.recovery).toBe('none');
    expect(r.message).toMatch(/권한이 없/);
  });

  it('status / errorCode 모두 없으면 network fallback', () => {
    const err = new Error('network');
    const r = friendlyError(err);
    expect(r.message).toMatch(/네트워크/);
    expect(r.recovery).toBe('retry');
  });

  it('Error 가 아니면 unknown fallback', () => {
    const r = friendlyError('not an error');
    expect(r.message).toMatch(/알 수 없/);
    expect(r.recovery).toBe('retry');
  });

  it('알 수 없는 errorCode + 알 수 없는 status → 4xx generic', () => {
    const err = Object.assign(new Error('?'), {
      errorCode: 'UNKNOWN_CODE',
      status: 418,
    });
    const r = friendlyError(err);
    expect(r.message).toMatch(/요청을 처리/);
    expect(r.recovery).toBe('none');
  });

  it('RECOVERY_LABEL 모든 action 한국어', () => {
    expect(RECOVERY_LABEL.retry).toBe('다시 시도');
    expect(RECOVERY_LABEL.cancel).toBe('취소');
    expect(RECOVERY_LABEL.refresh).toBe('새로고침');
    expect(RECOVERY_LABEL.login).toBe('로그인');
    expect(RECOVERY_LABEL.none).toBe('확인');
  });
});
