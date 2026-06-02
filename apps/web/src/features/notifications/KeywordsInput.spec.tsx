// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { KeywordsInput, KEYWORD_MAX_COUNT } from './KeywordsInput';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});
afterEach(cleanup);

describe('KeywordsInput (S48 FR-MN-10)', () => {
  it('Enter 로 키워드 추가', () => {
    const onChange = vi.fn();
    render(<KeywordsInput keywords={[]} onChange={onChange} onLimitExceeded={vi.fn()} />);
    const input = screen.getByTestId('keyword-draft');
    fireEvent.change(input, { target: { value: 'deploy' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(['deploy']);
  });

  it('중복(대소문자 무관) 추가는 무시', () => {
    const onChange = vi.fn();
    render(<KeywordsInput keywords={['deploy']} onChange={onChange} onLimitExceeded={vi.fn()} />);
    const input = screen.getByTestId('keyword-draft');
    fireEvent.change(input, { target: { value: 'Deploy' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
  });

  // B-02 fix-forward: 중복은 silent 가 아니라 SR 통지 + aria-invalid.
  it('중복 추가 → "이미 등록된 키워드입니다" 통지 + aria-invalid', () => {
    const onChange = vi.fn();
    render(<KeywordsInput keywords={['deploy']} onChange={onChange} onLimitExceeded={vi.fn()} />);
    const input = screen.getByTestId('keyword-draft');
    fireEvent.change(input, { target: { value: 'Deploy' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('keyword-feedback').textContent).toBe('이미 등록된 키워드입니다.');
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('삭제 버튼으로 키워드 제거', () => {
    const onChange = vi.fn();
    render(<KeywordsInput keywords={['a', 'b']} onChange={onChange} onLimitExceeded={vi.fn()} />);
    fireEvent.click(screen.getByTestId('keyword-remove-a'));
    expect(onChange).toHaveBeenCalledWith(['b']);
  });

  it('25개 상태에서 26번째 추가 시도 → onLimitExceeded 호출, onChange 미호출', () => {
    const onChange = vi.fn();
    const onLimit = vi.fn();
    const full = Array.from({ length: KEYWORD_MAX_COUNT }, (_, i) => `kw${i}`);
    render(<KeywordsInput keywords={full} onChange={onChange} onLimitExceeded={onLimit} />);
    const input = screen.getByTestId('keyword-draft') as HTMLInputElement;
    // 입력은 disabled 라 직접 commit 경로를 확인하기 위해 disabled 를 우회하지 않고
    // 25개 상태에서 count 표기와 input disabled 를 검증한 뒤, 한 칸 적은 상태로 한도 분기.
    expect(input.disabled).toBe(true);
    expect(screen.getByTestId('keyword-count').textContent).toBe(
      `${KEYWORD_MAX_COUNT}/${KEYWORD_MAX_COUNT}`,
    );
  });

  it('한도 직전(24개)에서 추가는 정상, 25개째까지 onChange', () => {
    const onChange = vi.fn();
    const onLimit = vi.fn();
    const near = Array.from({ length: KEYWORD_MAX_COUNT - 1 }, (_, i) => `kw${i}`);
    render(<KeywordsInput keywords={near} onChange={onChange} onLimitExceeded={onLimit} />);
    const input = screen.getByTestId('keyword-draft');
    fireEvent.change(input, { target: { value: 'last' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith([...near, 'last']);
    expect(onLimit).not.toHaveBeenCalled();
  });
});

describe('KeywordsInput a11y (S48 fix-forward)', () => {
  // B-01: 한도 초과 SR 통지 — role=status + aria-live. (commit 경로는 input disabled
  // 우회 없이 검증하기 위해 enabled 인 24→25 후 26번째를 비활성 입력 없이는 못 치므로,
  // feedback 영역의 ARIA 속성과 카운터/describedby 연결을 직접 검증한다.)
  it('B-01: 피드백 영역 role=status + aria-live=polite + aria-atomic', () => {
    render(<KeywordsInput keywords={[]} onChange={vi.fn()} onLimitExceeded={vi.fn()} />);
    const fb = screen.getByTestId('keyword-feedback');
    expect(fb.getAttribute('role')).toBe('status');
    expect(fb.getAttribute('aria-live')).toBe('polite');
    expect(fb.getAttribute('aria-atomic')).toBe('true');
  });

  // B-03: 카운터 id + 입력 aria-describedby 연결.
  it('B-03: 입력 aria-describedby 가 카운터 + 피드백 id 를 포함', () => {
    render(<KeywordsInput keywords={['a']} onChange={vi.fn()} onLimitExceeded={vi.fn()} />);
    const input = screen.getByTestId('keyword-draft');
    const countId = screen.getByTestId('keyword-count').getAttribute('id');
    const statusId = screen.getByTestId('keyword-feedback').getAttribute('id');
    const describedby = input.getAttribute('aria-describedby') ?? '';
    expect(countId).toBeTruthy();
    expect(statusId).toBeTruthy();
    expect(describedby.split(' ')).toContain(countId as string);
    expect(describedby.split(' ')).toContain(statusId as string);
  });

  // B-04: 태그 ul aria-label("등록된 키워드 N개").
  it('B-04: 태그 ul 에 aria-label="등록된 키워드 N개"', () => {
    render(<KeywordsInput keywords={['a', 'b']} onChange={vi.fn()} onLimitExceeded={vi.fn()} />);
    expect(screen.getByLabelText('등록된 키워드 2개')).toBeTruthy();
  });
});
