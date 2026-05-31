import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  EVERYONE_CONFIRM_THRESHOLD,
  BULK_MENTION_CONFIRM_THRESHOLD,
  PRESENCE_IDLE_TIMEOUT,
  TYPING_TTL,
  GAP_FETCH_MAX_PAGES,
  UNREAD_LOCK_TTL,
  SEQ_HOLE_TIMEOUT_MS,
  SHARED_CONSTANTS,
} from './constants';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('shared constants (ADR-8)', () => {
  it('matches the canonical ADR-8 values', () => {
    expect(EVERYONE_CONFIRM_THRESHOLD).toBe(6);
    expect(BULK_MENTION_CONFIRM_THRESHOLD).toBe(50);
    expect(PRESENCE_IDLE_TIMEOUT).toBe(600);
    expect(TYPING_TTL).toBe(10);
    expect(GAP_FETCH_MAX_PAGES).toBe(10);
    expect(UNREAD_LOCK_TTL).toBe(30000);
    expect(SEQ_HOLE_TIMEOUT_MS).toBe(500);
  });

  it('SHARED_CONSTANTS mirrors the individual exports', () => {
    expect(SHARED_CONSTANTS.EVERYONE_CONFIRM_THRESHOLD).toBe(EVERYONE_CONFIRM_THRESHOLD);
    expect(SHARED_CONSTANTS.UNREAD_LOCK_TTL).toBe(UNREAD_LOCK_TTL);
    expect(SHARED_CONSTANTS.GAP_FETCH_MAX_PAGES).toBe(GAP_FETCH_MAX_PAGES);
  });
});
