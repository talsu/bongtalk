import { describe, it, expect } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

/**
 * task-047 iter7 (P4): ErrorBoundary contract — class component 의
 * static getDerivedStateFromError 가 friendlyError 결과를 정상
 * 산출하는지 검증.
 *
 * Full render 테스트는 e2e (Playwright) 측 cover. 본 spec 은 contract.
 */

describe('ErrorBoundary contract (task-047 P4)', () => {
  it('class 가 export 되고 getDerivedStateFromError 가 함수', () => {
    expect(typeof ErrorBoundary).toBe('function');
    expect(typeof ErrorBoundary.getDerivedStateFromError).toBe('function');
  });

  it('getDerivedStateFromError 가 error state 반환', () => {
    const err = new Error('test');
    const next = ErrorBoundary.getDerivedStateFromError(err);
    expect(next.error).toBe(err);
  });
});
