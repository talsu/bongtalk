import { describe, it, expect } from 'vitest';
import { MESSAGE_SEND_TIMEOUT_MS_DEFAULT } from '@qufox/shared-types';
import { resolveSendTimeoutMs } from './sendTimeout';

/**
 * S09 (FR-RT-05): 전송 타임아웃 해석 순수 로직 단위 테스트.
 */
describe('resolveSendTimeoutMs (FR-RT-05)', () => {
  it('env 미설정이면 공유 기본값', () => {
    expect(resolveSendTimeoutMs(undefined)).toBe(MESSAGE_SEND_TIMEOUT_MS_DEFAULT);
    expect(resolveSendTimeoutMs('')).toBe(MESSAGE_SEND_TIMEOUT_MS_DEFAULT);
  });

  it('양의 정수 override 를 사용', () => {
    expect(resolveSendTimeoutMs('8000')).toBe(8000);
    expect(resolveSendTimeoutMs('1')).toBe(1);
  });

  it('소수는 내림', () => {
    expect(resolveSendTimeoutMs('1500.9')).toBe(1500);
  });

  it('0/음수/NaN 은 기본값으로 폴백', () => {
    expect(resolveSendTimeoutMs('0')).toBe(MESSAGE_SEND_TIMEOUT_MS_DEFAULT);
    expect(resolveSendTimeoutMs('-100')).toBe(MESSAGE_SEND_TIMEOUT_MS_DEFAULT);
    expect(resolveSendTimeoutMs('abc')).toBe(MESSAGE_SEND_TIMEOUT_MS_DEFAULT);
  });
});
