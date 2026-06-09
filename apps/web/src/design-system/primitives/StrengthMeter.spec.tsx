// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { StrengthMeter, evaluatePasswordStrength } from './StrengthMeter';

/**
 * AUTH-1 (PRD D18 / FR-AUTH-02 결): 비밀번호 강도 산출 순수함수의 경계값과
 * 미터 렌더(data-strength·라벨·막대 채움)를 jsdom 으로 검증한다. jest-dom 미사용 —
 * plain 매처(getByTestId / .getAttribute / .textContent / toBeNull)만 쓴다.
 */

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});
afterEach(() => cleanup());

describe('evaluatePasswordStrength — 경계', () => {
  it('빈 입력은 empty(막대 0·라벨 없음)', () => {
    const r = evaluatePasswordStrength('');
    expect(r.strength).toBe('empty');
    expect(r.filledBars).toBe(0);
    expect(r.label).toBe('');
  });

  it('짧고 단순한 비밀번호는 weak', () => {
    // 7자, 소문자만 → 길이/클래스 점수 0 → weak
    const r = evaluatePasswordStrength('abcdefg');
    expect(r.strength).toBe('weak');
    expect(r.filledBars).toBe(1);
    expect(r.label).toBe('약함');
  });

  it('8자 1클래스는 weak (score 1)', () => {
    // 8자(+1) · 1클래스(+0) → score 1 → weak
    const r = evaluatePasswordStrength('aaaaaaaa');
    expect(r.strength).toBe('weak');
  });

  it('8자 + 3클래스는 ok (권장 강도 하한 — 백엔드는 8자만 강제)', () => {
    // 8자(+1) · 3클래스 lower+upper+digit(2종+1, 3종+1=+2) → score 3 → ok
    const r = evaluatePasswordStrength('Abcdef12');
    expect(r.strength).toBe('ok');
    expect(r.filledBars).toBe(3);
    expect(r.label).toBe('보통');
  });

  it('12자 + 3클래스 이상은 strong', () => {
    // 12자(+2) · 3클래스 이상(+2) → score 4 → strong
    const r = evaluatePasswordStrength('Abcdef123456');
    expect(r.strength).toBe('strong');
    expect(r.filledBars).toBe(4);
    expect(r.label).toContain('강함');
  });

  it('12자 + 4클래스(기호 포함)는 strong', () => {
    const r = evaluatePasswordStrength('Abcdef123!@#');
    expect(r.strength).toBe('strong');
    expect(r.filledBars).toBe(4);
  });
});

describe('StrengthMeter — 렌더', () => {
  it('빈 비밀번호면 막대·라벨텍스트 없이 라이브영역만 유지(HIGH-2: 첫 전환 고지 보장)', () => {
    render(<StrengthMeter password="" />);
    // 컨테이너(라이브영역)는 DOM 에 존재하되 막대는 없고 라벨 텍스트는 비어 있다.
    const meter = screen.getByTestId('strength-meter');
    expect(meter.getAttribute('data-strength')).toBe('empty');
    expect(meter.className.includes('qf-strength-meter')).toBe(false);
    expect(screen.queryAllByTestId('strength-bar').length).toBe(0);
    expect(screen.getByTestId('strength-label').textContent).toBe('');
  });

  it('data-strength 와 라벨을 강도에 맞춰 노출한다(ok)', () => {
    render(<StrengthMeter password="Abcdef12" />);
    const meter = screen.getByTestId('strength-meter');
    expect(meter.getAttribute('data-strength')).toBe('ok');
    expect(screen.getByTestId('strength-label').textContent).toContain('보통');
  });

  it('strong 이면 막대 4개가 모두 채워진다(.is-on)', () => {
    render(<StrengthMeter password="Abcdef123456" />);
    const bars = screen.getAllByTestId('strength-bar');
    expect(bars.length).toBe(4);
    const onCount = bars.filter((b) => b.className.includes('is-on')).length;
    expect(onCount).toBe(4);
    expect(screen.getByTestId('strength-meter').getAttribute('data-strength')).toBe('strong');
  });

  it('라벨은 aria-live=polite 로 과한 낭독을 피한다', () => {
    render(<StrengthMeter password="Abcdef12" />);
    expect(screen.getByTestId('strength-label').getAttribute('aria-live')).toBe('polite');
  });
});
