import { describe, it, expect, beforeEach } from 'vitest';
import { useReadState } from './readStateStore';

/**
 * S09 (FR-RT-22 보조): 채널별 lastReadMessageId 읽기-상태 스토어.
 */
describe('useReadState (FR-RT-22 lastReadMessageId seam)', () => {
  beforeEach(() => {
    useReadState.setState({ lastReadByChannel: {} });
  });

  it('미보유 채널은 null', () => {
    expect(useReadState.getState().getLastRead('ch-x')).toBeNull();
  });

  it('setLastRead 후 getLastRead 가 값을 반환', () => {
    useReadState.getState().setLastRead('ch-1', 'm-9');
    expect(useReadState.getState().getLastRead('ch-1')).toBe('m-9');
  });

  it('null 로 설정하면 항목을 제거(다시 null)', () => {
    useReadState.getState().setLastRead('ch-1', 'm-9');
    useReadState.getState().setLastRead('ch-1', null);
    expect(useReadState.getState().getLastRead('ch-1')).toBeNull();
  });
});
