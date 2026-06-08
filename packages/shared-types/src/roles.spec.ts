import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RoleSchema, CreateRoleRequestSchema, UpdateRoleRequestSchema } from './roles';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

/**
 * S88a (FR-MN-03 · D6): Role.mentionable 와이어 계약.
 *
 * RoleSchema(응답)는 mentionable 을 필수로 노출하고, Create/Update 요청은
 * optional 로 받는다(미지정 시 서버가 false 기본 또는 무변경).
 */
describe('RoleSchema.mentionable (S88a / FR-MN-03)', () => {
  const base = {
    id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    workspaceId: '11111111-1111-1111-1111-111111111111',
    name: 'Project Managers',
    colorHex: null,
    position: 250,
    permissions: '0',
    isSystem: false,
    // FR-P09 (task-068 · S95): RoleSchema 는 hoistInMemberList 도 필수로 노출한다.
    hoistInMemberList: false,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  };

  it('응답 DTO 는 mentionable 을 필수로 요구한다', () => {
    const ok = RoleSchema.safeParse({ ...base, mentionable: true });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.mentionable).toBe(true);

    // mentionable 누락은 거부(응답 필수 — forward-compat 가 아님).
    const { mentionable: _omitMentionable, ...withoutMentionable } = { ...base, mentionable: true };
    const missing = RoleSchema.safeParse(withoutMentionable);
    expect(missing.success).toBe(false);
  });

  // FR-P09 (task-068 · S95): hoistInMemberList 와이어 계약(mentionable 동형).
  it('응답 DTO 는 hoistInMemberList 를 필수로 요구한다', () => {
    const ok = RoleSchema.safeParse({ ...base, mentionable: false, hoistInMemberList: true });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.hoistInMemberList).toBe(true);

    const { hoistInMemberList: _omit, ...withoutHoist } = { ...base, mentionable: false };
    const missing = RoleSchema.safeParse(withoutHoist);
    expect(missing.success).toBe(false);
  });
});

describe('CreateRoleRequestSchema.mentionable (S88a / FR-MN-03)', () => {
  it('mentionable 은 optional 이며 boolean 만 수용한다', () => {
    expect(CreateRoleRequestSchema.safeParse({ name: 'PM' }).success).toBe(true);
    expect(CreateRoleRequestSchema.safeParse({ name: 'PM', mentionable: true }).success).toBe(true);
    expect(CreateRoleRequestSchema.safeParse({ name: 'PM', mentionable: 'yes' }).success).toBe(
      false,
    );
  });
});

describe('UpdateRoleRequestSchema.mentionable (S88a / FR-MN-03)', () => {
  it('mentionable 단독 변경도 유효하다(at-least-one-field refine 통과)', () => {
    const res = UpdateRoleRequestSchema.safeParse({ mentionable: true });
    expect(res.success).toBe(true);
  });

  it('빈 객체는 여전히 거부된다(변경 필드 없음)', () => {
    expect(UpdateRoleRequestSchema.safeParse({}).success).toBe(false);
  });
});

// FR-P09 (task-068 · S95): hoistInMemberList 요청 계약(mentionable 동형).
describe('Create/Update RoleRequestSchema.hoistInMemberList (FR-P09)', () => {
  it('Create 에서 hoistInMemberList 는 optional 이며 boolean 만 수용한다', () => {
    expect(CreateRoleRequestSchema.safeParse({ name: 'Staff' }).success).toBe(true);
    expect(
      CreateRoleRequestSchema.safeParse({ name: 'Staff', hoistInMemberList: true }).success,
    ).toBe(true);
    expect(
      CreateRoleRequestSchema.safeParse({ name: 'Staff', hoistInMemberList: 'yes' }).success,
    ).toBe(false);
  });

  it('Update 에서 hoistInMemberList 단독 변경도 유효하다(refine 통과)', () => {
    expect(UpdateRoleRequestSchema.safeParse({ hoistInMemberList: true }).success).toBe(true);
    expect(UpdateRoleRequestSchema.safeParse({ hoistInMemberList: false }).success).toBe(true);
  });
});
