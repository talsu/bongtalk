import { describe, it, expect } from 'vitest';
import {
  BULK_MEMBER_ACTION_MAX,
  BulkMemberActionRequestSchema,
  BulkMemberActionResponseSchema,
  TIMEOUT_MAX_SECONDS,
  ListMemberDirectoryQuerySchema,
  ListMemberDirectoryResponseSchema,
  MemberDirectoryRowSchema,
} from './index';

const UID = '00000000-0000-4000-8000-000000000001';
const UID2 = '00000000-0000-4000-8000-000000000002';

describe('S69 timeout max (28일)', () => {
  it('상한이 28일(2419200초)로 확장된다', () => {
    expect(TIMEOUT_MAX_SECONDS).toBe(2419200);
  });
});

describe('S69 BulkMemberActionRequestSchema', () => {
  it('kick 액션은 userIds 만으로 통과한다', () => {
    expect(() =>
      BulkMemberActionRequestSchema.parse({ action: 'kick', userIds: [UID, UID2] }),
    ).not.toThrow();
  });

  it('timeout 액션은 durationSeconds 가 없으면 거부한다', () => {
    expect(() =>
      BulkMemberActionRequestSchema.parse({ action: 'timeout', userIds: [UID] }),
    ).toThrow();
  });

  it('timeout durationSeconds 가 28일 상한을 넘으면 거부한다', () => {
    expect(() =>
      BulkMemberActionRequestSchema.parse({
        action: 'timeout',
        userIds: [UID],
        durationSeconds: TIMEOUT_MAX_SECONDS + 1,
      }),
    ).toThrow();
    expect(() =>
      BulkMemberActionRequestSchema.parse({
        action: 'timeout',
        userIds: [UID],
        durationSeconds: TIMEOUT_MAX_SECONDS,
      }),
    ).not.toThrow();
  });

  it('role 액션은 role 이 없으면 거부한다', () => {
    expect(() => BulkMemberActionRequestSchema.parse({ action: 'role', userIds: [UID] })).toThrow();
    expect(() =>
      BulkMemberActionRequestSchema.parse({ action: 'role', userIds: [UID], role: 'MEMBER' }),
    ).not.toThrow();
  });

  it('role 액션은 OWNER 직접 배정을 거부한다', () => {
    expect(() =>
      BulkMemberActionRequestSchema.parse({ action: 'role', userIds: [UID], role: 'OWNER' }),
    ).toThrow();
  });

  it('userIds 가 100명을 넘으면 거부한다', () => {
    const tooMany = Array.from(
      { length: BULK_MEMBER_ACTION_MAX + 1 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    expect(() =>
      BulkMemberActionRequestSchema.parse({ action: 'kick', userIds: tooMany }),
    ).toThrow();
  });

  it('userIds 가 비어 있으면 거부한다', () => {
    expect(() => BulkMemberActionRequestSchema.parse({ action: 'kick', userIds: [] })).toThrow();
  });
});

describe('S69 BulkMemberActionResponseSchema', () => {
  it('affected/skipped 응답이 round-trip 한다', () => {
    const sample = {
      action: 'kick' as const,
      attemptedCount: 2,
      affected: [UID],
      skipped: [{ userId: UID2, reason: 'outranked' as const }],
    };
    expect(BulkMemberActionResponseSchema.parse(sample)).toEqual(sample);
  });
});

describe('S69 ListMemberDirectoryQuerySchema', () => {
  it('빈 쿼리도 통과한다(전체 조회)', () => {
    expect(() => ListMemberDirectoryQuerySchema.parse({})).not.toThrow();
  });

  it('q/role/sortBy/cursor 를 함께 받는다', () => {
    const parsed = ListMemberDirectoryQuerySchema.parse({
      q: 'al',
      role: 'ADMIN',
      sortBy: 'joined_asc',
      cursor: 'abc',
    });
    expect(parsed.role).toBe('ADMIN');
    expect(parsed.sortBy).toBe('joined_asc');
  });

  it('알 수 없는 sortBy 는 거부한다', () => {
    expect(() => ListMemberDirectoryQuerySchema.parse({ sortBy: 'name_asc' })).toThrow();
  });
});

describe('S69 MemberDirectoryRowSchema', () => {
  it('invitedById/invitedBy 를 포함한 행이 round-trip 한다', () => {
    const row = {
      userId: UID,
      workspaceId: '00000000-0000-4000-8000-0000000000aa',
      role: 'MEMBER' as const,
      joinedAt: '2025-01-01T00:00:00.000Z',
      user: { id: UID, username: 'alice', email: 'alice@example.com' },
      status: 'online' as const,
      lastSeenAt: null,
      mutedUntil: null,
      invitedById: UID2,
      invitedBy: { id: UID2, username: 'bob' },
    };
    expect(MemberDirectoryRowSchema.parse(row)).toMatchObject({ invitedById: UID2 });
  });

  it('invitedBy 가 null 인 공개 가입 멤버도 통과한다', () => {
    const row = {
      userId: UID,
      workspaceId: '00000000-0000-4000-8000-0000000000aa',
      role: 'MEMBER' as const,
      joinedAt: '2025-01-01T00:00:00.000Z',
      user: { id: UID, username: 'carol', email: 'carol@example.com' },
      status: 'offline' as const,
      lastSeenAt: null,
      invitedById: null,
      invitedBy: null,
    };
    expect(() => MemberDirectoryRowSchema.parse(row)).not.toThrow();
  });

  it('ListMemberDirectoryResponseSchema 는 nextCursor null 을 허용한다', () => {
    expect(() =>
      ListMemberDirectoryResponseSchema.parse({ members: [], nextCursor: null }),
    ).not.toThrow();
  });
});
