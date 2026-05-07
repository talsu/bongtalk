import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ErrorBoundary } from './ErrorBoundary';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, 'ErrorBoundary.tsx'), 'utf8');

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

  // 회귀: 정상 path 의 wrapper 가 plain <div> 면 부모 (AppLayout flex column,
  // height:100vh) 의 layout 흐름을 끊어 화면 전체가 children 의 intrinsic
  // height (workspace rail 의 아이콘 stack) 만큼 줄어드는 prod 회귀가
  // 발생함. Fragment 사용을 정적으로 강제.
  it('정상 path 가 wrapper div 가 아닌 Fragment 사용 (layout 흐름 보존)', () => {
    expect(SRC).toContain('<Fragment key={this.state.resetCount}>');
    expect(SRC).not.toMatch(/return\s*<div\s+key=\{this\.state\.resetCount\}>/);
  });
});
