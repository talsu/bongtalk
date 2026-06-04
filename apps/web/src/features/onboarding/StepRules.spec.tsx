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
  it('모든 규칙을 체크해야 동의 버튼이 활성화됩니다', () => {
    const onAccept = vi.fn();
    render(<StepRules rules={RULES} stepLabel="1 / 1 단계" pending={false} onAccept={onAccept} />);
    const btn = screen.getByTestId('onboarding-accept-rules') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);

    fireEvent.click(screen.getByTestId('rule-check-0'));
    expect(btn.disabled).toBe(true); // 아직 일부만 체크
    fireEvent.click(screen.getByTestId('rule-check-1'));
    expect(btn.disabled).toBe(false); // 전부 체크 → 활성화

    fireEvent.click(btn);
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it('처리 중(pending)이면 버튼이 비활성화됩니다', () => {
    render(<StepRules rules={RULES} stepLabel="1 / 1 단계" pending onAccept={() => undefined} />);
    expect((screen.getByTestId('onboarding-accept-rules') as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
