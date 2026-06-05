import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMediaCollapseStore } from './mediaCollapseStore';

/**
 * S81a (D15 / FR-SC-08) — `/collapse`·`/expand` 가 토글하는 채널별 인라인 미디어 접힘 상태.
 */
beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  useMediaCollapseStore.setState({ collapsedByChannel: {} });
});

describe('mediaCollapseStore', () => {
  it('기본은 펼침(false)', () => {
    expect(useMediaCollapseStore.getState().isCollapsed('ch1')).toBe(false);
  });

  it('setCollapsed(true) 면 해당 채널만 collapsed', () => {
    useMediaCollapseStore.getState().setCollapsed('ch1', true);
    expect(useMediaCollapseStore.getState().isCollapsed('ch1')).toBe(true);
    // 다른 채널은 영향 없음.
    expect(useMediaCollapseStore.getState().isCollapsed('ch2')).toBe(false);
  });

  it('expand(false) 면 다시 펼침', () => {
    useMediaCollapseStore.getState().setCollapsed('ch1', true);
    useMediaCollapseStore.getState().setCollapsed('ch1', false);
    expect(useMediaCollapseStore.getState().isCollapsed('ch1')).toBe(false);
  });
});
