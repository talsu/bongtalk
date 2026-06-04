// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { WorkspaceRule } from '@qufox/shared-types';
import { StepRules } from './StepRules';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  cleanup();
});

const RULES: WorkspaceRule[] = [
  { id: 'r1', position: 0, title: '서로 존중하기', description: '예의를 지켜주세요' },
  { id: 'r2', position: 1, title: '스팸 금지', description: null },
];

describe('S71 StepRules (FR-W07)', () => {
  it('a11y MAJOR-4: 미동의 시 aria-disabled 이고 onClick 이 early-return 합니다', () => {
    const onAccept = vi.fn();
    render(<StepRules rules={RULES} pending={false} onAccept={onAccept} />);
    const btn = screen.getByTestId('onboarding-accept-rules');
    // disabled 대신 aria-disabled — 버튼은 포커스 가능하되 동작만 막힌다.
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(btn.hasAttribute('disabled')).toBe(false);
    // aria-describedby 로 비활성 사유를 노출한다.
    expect(btn.getAttribute('aria-describedby')).toBeTruthy();

    fireEvent.click(btn);
    expect(onAccept).not.toHaveBeenCalled(); // 미동의 → early-return

    fireEvent.click(screen.getByTestId('rule-check-0'));
    fireEvent.click(btn);
    expect(onAccept).not.toHaveBeenCalled(); // 일부만 체크 → 여전히 막힘

    fireEvent.click(screen.getByTestId('rule-check-1'));
    expect(btn.getAttribute('aria-disabled')).toBe('false');
    expect(btn.getAttribute('aria-describedby')).toBeNull();
    fireEvent.click(btn);
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it('처리 중(pending)이면 동의 버튼이 동작하지 않습니다', () => {
    const onAccept = vi.fn();
    render(<StepRules rules={RULES} pending onAccept={onAccept} />);
    const btn = screen.getByTestId('onboarding-accept-rules');
    fireEvent.click(screen.getByTestId('rule-check-0'));
    fireEvent.click(screen.getByTestId('rule-check-1'));
    expect(btn.getAttribute('aria-disabled')).toBe('true'); // pending
    fireEvent.click(btn);
    expect(onAccept).not.toHaveBeenCalled();
  });

  it('a11y MAJOR-1: 소제목을 h3 로 노출합니다', () => {
    render(<StepRules rules={RULES} pending={false} onAccept={() => undefined} />);
    const heading = screen.getByRole('heading', { name: '커뮤니티 규칙' });
    expect(heading.tagName).toBe('H3');
  });
});
