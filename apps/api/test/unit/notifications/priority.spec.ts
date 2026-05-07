import { describe, it, expect } from 'vitest';
import { priorityFor, bypassesMute, isDigestable } from '../../../src/notifications/priority';

/**
 * task-047 iter2 (K2): 알림 우선순위 helper 검증.
 */

describe('priorityFor (task-047 K2)', () => {
  it('MENTION → high', () => {
    expect(priorityFor('MENTION')).toBe('high');
  });

  it('DIRECT (DM) → high', () => {
    expect(priorityFor('DIRECT')).toBe('high');
  });

  it('FRIEND_REQUEST → high', () => {
    expect(priorityFor('FRIEND_REQUEST')).toBe('high');
  });

  it('REPLY → medium', () => {
    expect(priorityFor('REPLY')).toBe('medium');
  });

  it('REACTION → low', () => {
    expect(priorityFor('REACTION')).toBe('low');
  });
});

describe('bypassesMute', () => {
  it('high 는 bypass 가능', () => {
    expect(bypassesMute('high')).toBe(true);
  });

  it('medium / low 는 bypass 불가', () => {
    expect(bypassesMute('medium')).toBe(false);
    expect(bypassesMute('low')).toBe(false);
  });
});

describe('isDigestable', () => {
  it('low 만 digest 가능', () => {
    expect(isDigestable('low')).toBe(true);
  });

  it('high / medium 은 즉시 dispatch', () => {
    expect(isDigestable('high')).toBe(false);
    expect(isDigestable('medium')).toBe(false);
  });
});
