import { describe, expect, it } from 'vitest';
import { DeleteWorkspaceRequestSchema, DeleteWorkspaceResponseSchema } from './workspace';

// S72 (D13 / FR-W15): 워크스페이스 삭제 confirmation 요청 + grace 종료 응답 contract.
describe('DeleteWorkspaceRequestSchema (FR-W15)', () => {
  it('accepts a string confirmation', () => {
    const parsed = DeleteWorkspaceRequestSchema.parse({ confirmation: 'acme-team' });
    expect(parsed.confirmation).toBe('acme-team');
  });

  it('rejects a missing or non-string confirmation', () => {
    expect(() => DeleteWorkspaceRequestSchema.parse({})).toThrow();
    expect(() => DeleteWorkspaceRequestSchema.parse({ confirmation: 123 })).toThrow();
  });
});

describe('DeleteWorkspaceResponseSchema (FR-W15)', () => {
  it('requires an ISO datetime deleteAt', () => {
    const parsed = DeleteWorkspaceResponseSchema.parse({
      deleteAt: '2025-01-31T00:00:00.000Z',
    });
    expect(parsed.deleteAt).toBe('2025-01-31T00:00:00.000Z');
    expect(() => DeleteWorkspaceResponseSchema.parse({ deleteAt: 'not-a-date' })).toThrow();
  });
});
