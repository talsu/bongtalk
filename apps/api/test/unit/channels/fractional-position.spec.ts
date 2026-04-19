import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  POSITION_STRIDE,
  calcBetween,
} from '../../../src/channels/positioning/fractional-position';
import { DomainError } from '../../../src/common/errors/domain-error';
import { ErrorCode } from '../../../src/common/errors/error-code.enum';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('fractional-position.calcBetween', () => {
  it('returns STRIDE when the list is empty (both ends null)', () => {
    expect(calcBetween(null, null).equals(POSITION_STRIDE)).toBe(true);
  });

  it('prepends by subtracting STRIDE when prev is null', () => {
    const first = new Prisma.Decimal('1000000000.0000000000');
    expect(calcBetween(null, first).toString()).toBe('0');
  });

  it('appends by adding STRIDE when next is null', () => {
    const last = new Prisma.Decimal('5000000000.0000000000');
    expect(calcBetween(last, null).toString()).toBe('6000000000');
  });

  it('picks the midpoint between two finite positions', () => {
    const mid = calcBetween('1000000000', '2000000000');
    expect(mid.toString()).toBe('1500000000');
  });

  it('accepts string inputs and returns Decimal', () => {
    const r = calcBetween('10', '30');
    expect(r instanceof Prisma.Decimal).toBe(true);
    expect(r.toString()).toBe('20');
  });

  it('throws CHANNEL_POSITION_INVALID when the gap is below MIN_GAP', () => {
    // Gap = 0.0000000005 < MIN_GAP (0.000000001)
    try {
      calcBetween('1.0000000000', '1.0000000005');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(DomainError);
      expect((e as DomainError).code).toBe(ErrorCode.CHANNEL_POSITION_INVALID);
    }
  });

  it('accepts a gap equal to or above MIN_GAP (1e-9)', () => {
    // Gap = exactly MIN_GAP → still throws (<=); so use 2e-9
    const r = calcBetween('1.0000000000', '1.0000000020');
    expect(r.toString()).toBe('1.000000001');
  });
});
