import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AUDIT_ACTION_LABELS } from './audit';

/**
 * S72 (D13 / FR-W22) contract Issue#1: 감사 로그 UI 가 raw enum 을 노출하지 않도록
 * SUSPICIOUS_JOIN / SUSPICIOUS_JOIN_THRESHOLD 한국어 라벨이 매핑돼 있어야 한다.
 */
beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('AUDIT_ACTION_LABELS', () => {
  it('maps the S72 IP soft-block actions to Korean labels', () => {
    expect(AUDIT_ACTION_LABELS.SUSPICIOUS_JOIN).toBe('의심 가입');
    expect(AUDIT_ACTION_LABELS.SUSPICIOUS_JOIN_THRESHOLD).toBe('의심 가입 임계값 도달');
  });

  it('maps INVITE_DELETED (destructive admin action) to a Korean label', () => {
    expect(AUDIT_ACTION_LABELS.INVITE_DELETED).toBe('초대 영구 삭제');
  });
});
