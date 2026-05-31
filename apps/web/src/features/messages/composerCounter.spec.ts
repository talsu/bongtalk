import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MESSAGE_MAX_LENGTH } from '@qufox/shared-types';
import { computeCounter } from './composerCounter';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('computeCounter (FR-MSG-03 / FR-RC17)', () => {
  it('reports remaining = MAX for empty input', () => {
    const c = computeCounter('');
    expect(c.length).toBe(0);
    expect(c.remaining).toBe(MESSAGE_MAX_LENGTH);
    expect(c.overLimit).toBe(false);
  });

  it('counts characters', () => {
    const c = computeCounter('hello');
    expect(c.length).toBe(5);
    expect(c.remaining).toBe(MESSAGE_MAX_LENGTH - 5);
  });

  it('is not over the limit at exactly MAX', () => {
    const c = computeCounter('a'.repeat(MESSAGE_MAX_LENGTH));
    expect(c.overLimit).toBe(false);
    expect(c.remaining).toBe(0);
  });

  it('is over the limit at MAX+1 with negative remaining', () => {
    const c = computeCounter('a'.repeat(MESSAGE_MAX_LENGTH + 1));
    expect(c.overLimit).toBe(true);
    expect(c.remaining).toBe(-1);
  });

  it('enters the warning zone within COUNTER_WARN_THRESHOLD of the limit', () => {
    // length where remaining <= warn threshold but not over.
    const c = computeCounter('a'.repeat(MESSAGE_MAX_LENGTH - 50));
    expect(c.warn).toBe(true);
    expect(c.overLimit).toBe(false);
  });

  it('does not warn well under the limit', () => {
    const c = computeCounter('short');
    expect(c.warn).toBe(false);
  });

  it('shouldShow is false for empty + well-under, true once warn/over', () => {
    expect(computeCounter('').shouldShow).toBe(false);
    expect(computeCounter('hi').shouldShow).toBe(false);
    expect(computeCounter('a'.repeat(MESSAGE_MAX_LENGTH - 10)).shouldShow).toBe(true);
    expect(computeCounter('a'.repeat(MESSAGE_MAX_LENGTH + 5)).shouldShow).toBe(true);
  });

  it('canSend gates on over-limit only (empty handled by caller)', () => {
    expect(computeCounter('a'.repeat(MESSAGE_MAX_LENGTH)).canSend).toBe(true);
    expect(computeCounter('a'.repeat(MESSAGE_MAX_LENGTH + 1)).canSend).toBe(false);
  });
});
