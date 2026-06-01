import { describe, it, expect, beforeEach, vi } from 'vitest';
import { classifyReadShortcut } from './readShortcut';

/**
 * S23 (FR-RS-11): Esc=현재 채널 읽음 / Shift+Esc=워크스페이스 전체 읽음 단축키
 * 분류의 순수 로직. 입력 필드 포커스(컴포저 등) 중에는 어느 쪽도 발화하지
 * 않아(none) 기존 Esc 동작(자동완성 닫기/포커스 해제)을 무회귀로 둔다.
 */
beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

function ev(over: Partial<{ key: string; shiftKey: boolean }>): KeyboardEvent {
  return {
    key: over.key ?? 'Escape',
    shiftKey: over.shiftKey ?? false,
  } as KeyboardEvent;
}

describe('classifyReadShortcut (FR-RS-11)', () => {
  it('Esc(수정자 없음) → mark-current', () => {
    expect(
      classifyReadShortcut(ev({ key: 'Escape' }), { inputActive: false, modalOpen: false }),
    ).toBe('mark-current');
  });

  it('Shift+Esc → mark-all', () => {
    expect(
      classifyReadShortcut(ev({ key: 'Escape', shiftKey: true }), {
        inputActive: false,
        modalOpen: false,
      }),
    ).toBe('mark-all');
  });

  it('입력 필드 포커스 중 Esc → none(컴포저 무회귀)', () => {
    expect(
      classifyReadShortcut(ev({ key: 'Escape' }), { inputActive: true, modalOpen: false }),
    ).toBe('none');
  });

  it('입력 필드 포커스 중 Shift+Esc → none', () => {
    expect(
      classifyReadShortcut(ev({ key: 'Escape', shiftKey: true }), {
        inputActive: true,
        modalOpen: false,
      }),
    ).toBe('none');
  });

  it('모달이 열려 있으면 Esc → none(모달 닫기가 우선)', () => {
    expect(
      classifyReadShortcut(ev({ key: 'Escape' }), { inputActive: false, modalOpen: true }),
    ).toBe('none');
  });

  it('Escape 외 키는 none', () => {
    expect(
      classifyReadShortcut(ev({ key: 'Enter' }), { inputActive: false, modalOpen: false }),
    ).toBe('none');
  });
});
