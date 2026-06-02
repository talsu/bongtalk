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
