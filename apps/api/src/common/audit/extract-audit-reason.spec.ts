import { describe, expect, it } from 'vitest';
import { extractAuditReason } from './audit.service';

/**
 * 072 백로그 S-G (FR-RM12): 감사 로그 details(Json)에서 reason 평탄화 — 5열 표시용.
 * 객체이고 reason 이 비어있지 않은 문자열일 때만 반환, 그 외 null.
 */
describe('extractAuditReason', () => {
  it('details.reason 이 비어있지 않은 문자열이면 그대로 반환', () => {
    expect(extractAuditReason({ reason: '스팸' })).toBe('스팸');
    expect(extractAuditReason({ reason: 'abuse', duration: 600 })).toBe('abuse');
  });

  it('reason 없음/빈문자/공백/비문자열/null/배열은 null', () => {
    expect(extractAuditReason(null)).toBeNull();
    expect(extractAuditReason(undefined)).toBeNull();
    expect(extractAuditReason({})).toBeNull();
    expect(extractAuditReason({ reason: '' })).toBeNull();
    expect(extractAuditReason({ reason: '   ' })).toBeNull();
    expect(extractAuditReason({ reason: 123 })).toBeNull();
    expect(extractAuditReason([{ reason: 'x' }])).toBeNull();
    expect(extractAuditReason('스팸')).toBeNull();
  });
});
