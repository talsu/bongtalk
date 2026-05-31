import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { MessageDto, MessageType } from '@qufox/shared-types';
import { computeGrouping, isContinuation } from './grouping';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

let seq = 0;
function msg(
  partial: Partial<MessageDto> & { authorId: string; createdAt: string; type?: MessageType },
): MessageDto {
  seq += 1;
  return {
    id: `m-${seq}`,
    channelId: 'c1',
    content: 'hi',
    contentRaw: 'hi',
    contentAst: null,
    type: 'DEFAULT',
    mentions: { users: [], channels: [], everyone: false, here: false },
    edited: false,
    deleted: false,
    editedAt: null,
    reactions: [],
    parentMessageId: null,
    thread: null,
    attachments: [],
    pinnedAt: null,
    pinnedBy: null,
    ...partial,
  } as MessageDto;
}

describe('isContinuation (FR-MSG-10)', () => {
  it('groups same-author messages within 5 minutes', () => {
    const a = msg({ authorId: 'u1', createdAt: '2025-01-01T00:00:00.000Z' });
    const b = msg({ authorId: 'u1', createdAt: '2025-01-01T00:02:00.000Z' });
    expect(isContinuation(b, a)).toBe(true);
  });

  it('breaks group after 5 minutes', () => {
    const a = msg({ authorId: 'u1', createdAt: '2025-01-01T00:00:00.000Z' });
    const b = msg({ authorId: 'u1', createdAt: '2025-01-01T00:06:00.000Z' });
    expect(isContinuation(b, a)).toBe(false);
  });

  it('breaks group when author differs', () => {
    const a = msg({ authorId: 'u1', createdAt: '2025-01-01T00:00:00.000Z' });
    const b = msg({ authorId: 'u2', createdAt: '2025-01-01T00:01:00.000Z' });
    expect(isContinuation(b, a)).toBe(false);
  });

  it('first message is never a continuation', () => {
    const a = msg({ authorId: 'u1', createdAt: '2025-01-01T00:00:00.000Z' });
    expect(isContinuation(a, null)).toBe(false);
  });
});

describe('SYSTEM_* grouping (FR-MSG-19 — grouped=false + ±1 recompute)', () => {
  it('a system message is never grouped', () => {
    const a = msg({ authorId: 'u1', createdAt: '2025-01-01T00:00:00.000Z' });
    const sys = msg({
      authorId: 'u1',
      createdAt: '2025-01-01T00:01:00.000Z',
      type: 'SYSTEM_CHANNEL_TOPIC_CHANGED',
    });
    expect(isContinuation(sys, a)).toBe(false);
  });

  it('a normal message following a system message is NOT grouped (chain broken)', () => {
    const sys = msg({
      authorId: 'u1',
      createdAt: '2025-01-01T00:00:00.000Z',
      type: 'SYSTEM_CHANNEL_TOPIC_CHANGED',
    });
    // same author, within 5 minutes — but prev is a system row.
    const after = msg({ authorId: 'u1', createdAt: '2025-01-01T00:01:00.000Z' });
    expect(isContinuation(after, sys)).toBe(false);
  });

  it('inserting a system message between two grouped messages recomputes ±1', () => {
    const a = msg({ authorId: 'u1', createdAt: '2025-01-01T00:00:00.000Z' });
    const b = msg({ authorId: 'u1', createdAt: '2025-01-01T00:01:00.000Z' });
    // before insert: b is grouped onto a.
    expect(computeGrouping([a, b])).toEqual([false, true]);
    // insert system topic-change between a and b.
    const sys = msg({
      authorId: 'u1',
      createdAt: '2025-01-01T00:00:30.000Z',
      type: 'SYSTEM_CHANNEL_TOPIC_CHANGED',
    });
    // after insert: system row not grouped, and b loses its group (prev=system).
    expect(computeGrouping([a, sys, b])).toEqual([false, false, false]);
  });
});
