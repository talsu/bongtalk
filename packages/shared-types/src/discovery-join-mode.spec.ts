import { describe, expect, it } from 'vitest';
import {
  DiscoveryWorkspaceSchema,
  WorkspaceJoinModeSchema,
  type WorkspaceJoinMode,
} from './workspace';

/**
 * S72 W16 fix-forward (contract LOW): joinMode 디스커버리 노출 contract.
 *  - WorkspaceJoinModeSchema 가 PRIVATE / PUBLIC / APPLY 세 enum 값을 모두 받고 그 외는
 *    거부한다.
 *  - DiscoveryWorkspaceSchema.joinMode 는 누락 시 'PUBLIC' 으로 기본값을 채운다(구 캐시
 *    payload 에 joinMode 가 없어도 안전 — discover 는 visibility=PUBLIC 만 노출하므로 가장
 *    흔한 PUBLIC 으로 폴백).
 */
describe('WorkspaceJoinModeSchema (FR-W16)', () => {
  it('accepts every enum member', () => {
    const all: WorkspaceJoinMode[] = ['PRIVATE', 'PUBLIC', 'APPLY'];
    for (const mode of all) {
      expect(WorkspaceJoinModeSchema.parse(mode)).toBe(mode);
    }
  });

  it('rejects an unknown join mode', () => {
    expect(() => WorkspaceJoinModeSchema.parse('OPEN')).toThrow();
    expect(() => WorkspaceJoinModeSchema.parse('private')).toThrow();
  });
});

describe('DiscoveryWorkspaceSchema.joinMode (FR-W16)', () => {
  const base = {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'Cache Forge',
    slug: 'cache-forge',
    description: 'a workspace',
    iconUrl: null,
    category: 'PROGRAMMING' as const,
    memberCount: 3,
    lastActivityAt: null,
  };

  it("defaults joinMode to 'PUBLIC' when absent", () => {
    const parsed = DiscoveryWorkspaceSchema.parse(base);
    expect(parsed.joinMode).toBe('PUBLIC');
  });

  it('preserves an explicit joinMode', () => {
    for (const mode of ['PRIVATE', 'PUBLIC', 'APPLY'] as const) {
      const parsed = DiscoveryWorkspaceSchema.parse({ ...base, joinMode: mode });
      expect(parsed.joinMode).toBe(mode);
    }
  });

  it('rejects an invalid joinMode value', () => {
    expect(() => DiscoveryWorkspaceSchema.parse({ ...base, joinMode: 'NOPE' })).toThrow();
  });
});
