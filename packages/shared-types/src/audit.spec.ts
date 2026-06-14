import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AUDIT_ACTION_LABELS, AuditLogEntrySchema } from './audit';

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

// 072 백로그 S-G (FR-RM12): 감사 로그 5열용 target/reason 계약.
describe('AuditLogEntrySchema target/reason (072 S-G)', () => {
  const base = {
    id: '11111111-1111-4111-8111-111111111111',
    workspaceId: '22222222-2222-4222-8222-222222222222',
    actorId: '33333333-3333-4333-8333-333333333333',
    action: 'KICK_MEMBER',
    targetId: '44444444-4444-4444-8444-444444444444',
    channelId: null,
    details: { reason: '스팸' },
    createdAt: '2025-01-01T00:00:00.000Z',
    actor: { id: '33333333-3333-4333-8333-333333333333', username: 'mod' },
  };

  it('target(사용자 해석) + reason 을 실어 파싱된다', () => {
    const parsed = AuditLogEntrySchema.safeParse({
      ...base,
      target: { id: base.targetId, username: 'victim' },
      reason: '스팸',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.target?.username).toBe('victim');
      expect(parsed.data.reason).toBe('스팸');
    }
  });

  it('target/reason 은 optional(구 클라/캐시 안전) — 생략·null 모두 통과', () => {
    expect(AuditLogEntrySchema.safeParse(base).success).toBe(true);
    expect(AuditLogEntrySchema.safeParse({ ...base, target: null, reason: null }).success).toBe(
      true,
    );
  });
});
