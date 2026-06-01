import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toastContainerKind, toastLiveAriaLive, toastLiveRole } from './toastRole';

/**
 * S24 fix-forward (a11y BLOCKER #6): 토스트 컨테이너 종류 + 라이브 role 판정.
 *  - action(Undo 버튼) 토스트는 라이브 리전(status/alert)에 인터랙티브 button 을
 *    중첩하지 않도록 'plain-action'(role 없는 컨테이너).
 *  - onActivate 만 있는 토스트는 전체 클릭 가능한 'interactive-button'.
 *  - 텍스트 전용 토스트는 'live-region'.
 */
beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('toastContainerKind (FR a11y BLOCKER #6)', () => {
  it('action 토스트(Undo)는 plain-action — 라이브 리전 미사용', () => {
    expect(toastContainerKind({ action: { label: '실행 취소', onClick: () => undefined } })).toBe(
      'plain-action',
    );
  });

  it('action 이 onActivate 보다 우선 — 둘 다 있어도 plain-action', () => {
    expect(
      toastContainerKind({
        action: { label: '실행 취소', onClick: () => undefined },
        onActivate: () => undefined,
      }),
    ).toBe('plain-action');
  });

  it('onActivate 만 있으면 interactive-button', () => {
    expect(toastContainerKind({ onActivate: () => undefined })).toBe('interactive-button');
  });

  it('아무 핸들러도 없으면 live-region', () => {
    expect(toastContainerKind({})).toBe('live-region');
  });
});

describe('toastLiveRole / toastLiveAriaLive', () => {
  it('danger 는 alert + assertive', () => {
    expect(toastLiveRole('danger')).toBe('alert');
    expect(toastLiveAriaLive('danger')).toBe('assertive');
  });

  it.each(['info', 'success', 'warning', 'mention'] as const)('%s 는 status + polite', (v) => {
    expect(toastLiveRole(v)).toBe('status');
    expect(toastLiveAriaLive(v)).toBe('polite');
  });
});
