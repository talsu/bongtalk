import { describe, it, expect, beforeEach, vi } from 'vitest';
import { transition, shouldBufferIncoming, type ChannelSyncState } from './channelSyncFsm';

/**
 * S10 (FR-RT-07): 채널 단위 재연결 FSM 전이 단위 테스트.
 */
describe('channelSyncFsm.transition', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime('2025-01-01T00:00:00Z');
  });

  it('DISCONNECTED → connect → RECONNECTING', () => {
    expect(transition('DISCONNECTED', { type: 'connect' })).toBe('RECONNECTING');
  });

  it('RECONNECTING → replayComplete → SYNCED (짧은 재연결, replay 가 커버)', () => {
    expect(transition('RECONNECTING', { type: 'replayComplete' })).toBe('SYNCED');
  });

  it('RECONNECTING → gapNeeded(replay.truncated) → GAP_FETCHING', () => {
    expect(transition('RECONNECTING', { type: 'gapNeeded' })).toBe('GAP_FETCHING');
  });

  it('RECONNECTING → seqHole → GAP_FETCHING', () => {
    expect(transition('RECONNECTING', { type: 'seqHole' })).toBe('GAP_FETCHING');
  });

  it('GAP_FETCHING → synced → SYNCED', () => {
    expect(transition('GAP_FETCHING', { type: 'synced' })).toBe('SYNCED');
  });

  it('GAP_FETCHING → failed → SYNC_FAILED', () => {
    expect(transition('GAP_FETCHING', { type: 'failed' })).toBe('SYNC_FAILED');
  });

  it('GAP_FETCHING 중 추가 hole/gapNeeded 는 상태 유지(재진입 무의미)', () => {
    expect(transition('GAP_FETCHING', { type: 'seqHole' })).toBe('GAP_FETCHING');
    expect(transition('GAP_FETCHING', { type: 'gapNeeded' })).toBe('GAP_FETCHING');
  });

  it('SYNC_FAILED → retry → GAP_FETCHING', () => {
    expect(transition('SYNC_FAILED', { type: 'retry' })).toBe('GAP_FETCHING');
  });

  it('SYNCED 중 seqHole 감지 → GAP_FETCHING 재진입', () => {
    expect(transition('SYNCED', { type: 'seqHole' })).toBe('GAP_FETCHING');
    expect(transition('SYNCED', { type: 'gapNeeded' })).toBe('GAP_FETCHING');
  });

  it('어느 상태에서든 disconnect → DISCONNECTED', () => {
    const states: ChannelSyncState[] = [
      'DISCONNECTED',
      'RECONNECTING',
      'GAP_FETCHING',
      'SYNCED',
      'SYNC_FAILED',
    ];
    for (const s of states) {
      expect(transition(s, { type: 'disconnect' })).toBe('DISCONNECTED');
    }
  });

  it('새 connect 사이클은 SYNCED/SYNC_FAILED 에서 RECONNECTING 으로 되돌림', () => {
    expect(transition('SYNCED', { type: 'connect' })).toBe('RECONNECTING');
    expect(transition('SYNC_FAILED', { type: 'connect' })).toBe('RECONNECTING');
  });

  it('정의되지 않은 전이는 현재 상태 유지(no-op)', () => {
    expect(transition('DISCONNECTED', { type: 'synced' })).toBe('DISCONNECTED');
    expect(transition('SYNCED', { type: 'replayComplete' })).toBe('SYNCED');
    expect(transition('RECONNECTING', { type: 'retry' })).toBe('RECONNECTING');
  });

  it('전체 happy-path 시퀀스: 재연결 → 갭 감지 → 동기화 완료', () => {
    let s: ChannelSyncState = 'DISCONNECTED';
    s = transition(s, { type: 'connect' });
    expect(s).toBe('RECONNECTING');
    s = transition(s, { type: 'gapNeeded' });
    expect(s).toBe('GAP_FETCHING');
    s = transition(s, { type: 'synced' });
    expect(s).toBe('SYNCED');
  });

  it('shouldBufferIncoming 은 GAP_FETCHING 에서만 true', () => {
    expect(shouldBufferIncoming('GAP_FETCHING')).toBe(true);
    expect(shouldBufferIncoming('SYNCED')).toBe(false);
    expect(shouldBufferIncoming('RECONNECTING')).toBe(false);
    expect(shouldBufferIncoming('DISCONNECTED')).toBe(false);
    expect(shouldBufferIncoming('SYNC_FAILED')).toBe(false);
  });
});
