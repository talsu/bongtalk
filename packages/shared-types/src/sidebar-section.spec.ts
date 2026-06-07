import { describe, expect, it } from 'vitest';
import {
  AssignSidebarChannelRequestSchema,
  CreateSidebarSectionRequestSchema,
  MoveSidebarChannelRequestSchema,
  MoveSidebarSectionRequestSchema,
  SidebarSectionSchema,
  SidebarSectionsResponseSchema,
  UpdateSidebarSectionRequestSchema,
} from './sidebar-section';

/**
 * S85 (FR-CH-16): 사이드바 개인 섹션 컨트랙트 Zod 검증.
 */
describe('CreateSidebarSectionRequestSchema', () => {
  it('이름만으로 통과(emoji/sortMode 선택)', () => {
    const r = CreateSidebarSectionRequestSchema.safeParse({ name: '작업' });
    expect(r.success).toBe(true);
  });

  it('emoji + sortMode 동반 통과', () => {
    const r = CreateSidebarSectionRequestSchema.safeParse({
      name: '즐겨찾는 프로젝트',
      emoji: '📌',
      sortMode: 'ALPHABETICAL',
    });
    expect(r.success).toBe(true);
  });

  it('빈 이름 거부', () => {
    expect(CreateSidebarSectionRequestSchema.safeParse({ name: '' }).success).toBe(false);
  });

  it('100자 초과 이름 거부', () => {
    expect(CreateSidebarSectionRequestSchema.safeParse({ name: 'x'.repeat(101) }).success).toBe(
      false,
    );
  });

  it('16자 초과 emoji 거부', () => {
    expect(
      CreateSidebarSectionRequestSchema.safeParse({ name: 'a', emoji: 'z'.repeat(17) }).success,
    ).toBe(false);
  });

  it('미지원 sortMode 거부', () => {
    expect(
      CreateSidebarSectionRequestSchema.safeParse({ name: 'a', sortMode: 'RECENT' }).success,
    ).toBe(false);
  });
});

describe('UpdateSidebarSectionRequestSchema', () => {
  it('빈 객체(no-op) 통과', () => {
    expect(UpdateSidebarSectionRequestSchema.safeParse({}).success).toBe(true);
  });

  it('emoji null 로 제거 가능', () => {
    const r = UpdateSidebarSectionRequestSchema.safeParse({ emoji: null });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.emoji).toBeNull();
  });
});

describe('AssignSidebarChannelRequestSchema', () => {
  it('uuid channelId 통과', () => {
    const r = AssignSidebarChannelRequestSchema.safeParse({
      channelId: '11111111-1111-1111-1111-111111111111',
    });
    expect(r.success).toBe(true);
  });

  it('비 uuid 거부', () => {
    expect(AssignSidebarChannelRequestSchema.safeParse({ channelId: 'nope' }).success).toBe(false);
  });
});

describe('MoveSidebarSectionRequestSchema', () => {
  const uuid = '22222222-2222-2222-2222-222222222222';
  it('beforeId 단독 통과', () => {
    expect(MoveSidebarSectionRequestSchema.safeParse({ beforeId: uuid }).success).toBe(true);
  });
  it('빈 객체(말단) 통과', () => {
    expect(MoveSidebarSectionRequestSchema.safeParse({}).success).toBe(true);
  });
  it('beforeId + afterId 동시 거부(상호 배타)', () => {
    expect(
      MoveSidebarSectionRequestSchema.safeParse({ beforeId: uuid, afterId: uuid }).success,
    ).toBe(false);
  });
});

describe('MoveSidebarChannelRequestSchema', () => {
  const uuid = '33333333-3333-3333-3333-333333333333';
  it('sectionId + anchor 통과(섹션 간 이동)', () => {
    expect(
      MoveSidebarChannelRequestSchema.safeParse({ sectionId: uuid, afterId: uuid }).success,
    ).toBe(true);
  });
  it('beforeId + afterId 동시 거부', () => {
    expect(
      MoveSidebarChannelRequestSchema.safeParse({ beforeId: uuid, afterId: uuid }).success,
    ).toBe(false);
  });
});

describe('SidebarSection 응답 DTO', () => {
  const section = {
    id: '44444444-4444-4444-4444-444444444444',
    workspaceId: '55555555-5555-5555-5555-555555555555',
    name: '작업',
    emoji: null,
    sortMode: 'MANUAL' as const,
    position: '1000000000',
    channelIds: ['66666666-6666-6666-6666-666666666666'],
    createdAt: '2025-01-01T00:00:00.000Z',
  };

  it('단일 섹션 DTO 통과', () => {
    expect(SidebarSectionSchema.safeParse(section).success).toBe(true);
  });

  it('목록 응답 통과', () => {
    expect(SidebarSectionsResponseSchema.safeParse({ sections: [section] }).success).toBe(true);
  });
});
