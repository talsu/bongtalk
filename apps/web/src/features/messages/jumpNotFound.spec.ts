import { describe, expect, it } from 'vitest';
import { shouldToastJumpNotFound } from './jumpNotFound';

/**
 * S37 (FR-MSG-18): permalink 점프 not-found 토스트 판정 순수 함수 단위 테스트.
 */
describe('shouldToastJumpNotFound (FR-MSG-18)', () => {
  it('점프 대상이 없으면(jumpMessageId=null) 항상 false', () => {
    expect(
      shouldToastJumpNotFound({ jumpMessageId: null, settled: true, found: false, isError: true }),
    ).toBe(false);
  });

  it('로딩 중(settled=false)이면 not-found 판정을 보류한다(false)', () => {
    expect(
      shouldToastJumpNotFound({
        jumpMessageId: 'm-1',
        settled: false,
        found: false,
        isError: false,
      }),
    ).toBe(false);
  });

  it('로드 완료 + 대상 존재(found=true) 면 토스트 없음', () => {
    expect(
      shouldToastJumpNotFound({
        jumpMessageId: 'm-1',
        settled: true,
        found: true,
        isError: false,
      }),
    ).toBe(false);
  });

  it('로드 완료 + 대상 없음(soft-deleted 필터, found=false) → 토스트', () => {
    expect(
      shouldToastJumpNotFound({
        jumpMessageId: 'm-1',
        settled: true,
        found: false,
        isError: false,
      }),
    ).toBe(true);
  });

  it('에러(404 anchor not found) → 토스트', () => {
    expect(
      shouldToastJumpNotFound({
        jumpMessageId: 'm-1',
        settled: true,
        found: false,
        isError: true,
      }),
    ).toBe(true);
  });
});
