import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isContextMenuKey, markReadAriaLabel } from './unreadsA11y';

/**
 * S24 fix-forward (a11y BLOCKER #4/#5): Unreads "읽음 처리" 채널별 라벨 +
 * 키보드 컨텍스트 메뉴 키 판정.
 */
beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('markReadAriaLabel (BLOCKER #5)', () => {
  it('채널명을 포함한 고유 라벨을 만든다(다중 동일 라벨 해소)', () => {
    expect(markReadAriaLabel('general')).toBe('# general 읽음 처리');
    expect(markReadAriaLabel('release-notes')).toBe('# release-notes 읽음 처리');
  });

  it('서로 다른 채널은 서로 다른 라벨을 만든다', () => {
    expect(markReadAriaLabel('a')).not.toBe(markReadAriaLabel('b'));
  });
});

describe('isContextMenuKey (BLOCKER #4)', () => {
  it('ContextMenu 키는 메뉴를 연다', () => {
    expect(isContextMenuKey({ key: 'ContextMenu', shiftKey: false })).toBe(true);
  });

  it('Shift+F10 은 메뉴를 연다', () => {
    expect(isContextMenuKey({ key: 'F10', shiftKey: true })).toBe(true);
  });

  it('Shift 없는 F10 은 열지 않는다', () => {
    expect(isContextMenuKey({ key: 'F10', shiftKey: false })).toBe(false);
  });

  it('무관한 키는 열지 않는다', () => {
    expect(isContextMenuKey({ key: 'Enter', shiftKey: false })).toBe(false);
    expect(isContextMenuKey({ key: 'a', shiftKey: true })).toBe(false);
  });
});
