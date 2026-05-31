import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serializeBigInts, bigIntReplacer, hasBigInt } from './bigint';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('serializeBigInts (ADR-11)', () => {
  it('converts a top-level bigint to string', () => {
    expect(serializeBigInts(42n)).toBe('42');
  });

  it('converts bigint fields nested in objects', () => {
    const input = { allow: 1n, deny: 0n, nested: { mask: 9007199254740993n } };
    expect(serializeBigInts(input)).toEqual({
      allow: '1',
      deny: '0',
      nested: { mask: '9007199254740993' },
    });
  });

  it('converts bigints inside arrays', () => {
    expect(serializeBigInts([1n, 2n, { x: 3n }])).toEqual(['1', '2', { x: '3' }]);
  });

  it('leaves non-bigint values untouched', () => {
    const input = { a: 'str', b: 1, c: true, d: null, e: undefined };
    expect(serializeBigInts(input)).toEqual({ a: 'str', b: 1, c: true, d: null, e: undefined });
  });

  it('preserves Date instances (does not recurse into them)', () => {
    const d = new Date('2025-01-01T00:00:00Z');
    const out = serializeBigInts({ when: d }) as { when: Date };
    expect(out.when).toBeInstanceOf(Date);
    expect(out.when.getTime()).toBe(d.getTime());
  });

  it('handles the ADMINISTRATOR 1<<63 bit without precision loss', () => {
    const big = 1n << 63n;
    expect(serializeBigInts({ allow: big })).toEqual({ allow: '9223372036854775808' });
  });

  it('returns primitives unchanged', () => {
    expect(serializeBigInts('hi')).toBe('hi');
    expect(serializeBigInts(7)).toBe(7);
    expect(serializeBigInts(null)).toBe(null);
  });

  it('does not stack-overflow on a self-referential object (cycle guard)', () => {
    const node: Record<string, unknown> = { seq: 5n };
    node.self = node;
    const out = serializeBigInts(node) as Record<string, unknown>;
    expect(out.seq).toBe('5');
    // cycle 진입점은 원본 노드를 그대로 반환(무한 재귀 안 함).
    expect(out.self).toBe(node);
  });

  it('does not stack-overflow on a cyclic array', () => {
    const arr: unknown[] = [1n];
    arr.push(arr);
    expect(() => serializeBigInts(arr)).not.toThrow();
  });
});

describe('hasBigInt (interceptor early-exit)', () => {
  it('detects a top-level bigint', () => {
    expect(hasBigInt(9n)).toBe(true);
  });
  it('detects a nested bigint', () => {
    expect(hasBigInt({ a: { b: [{ c: 1n }] } })).toBe(true);
  });
  it('returns false for bigint-free payloads', () => {
    expect(hasBigInt({ a: 'x', b: 1, c: [true, null] })).toBe(false);
  });
  it('returns false (no throw) on a cyclic bigint-free object', () => {
    const node: Record<string, unknown> = { a: 1 };
    node.self = node;
    expect(hasBigInt(node)).toBe(false);
  });
});

describe('bigIntReplacer (JSON.stringify replacer)', () => {
  it('stringifies bigint values via JSON.stringify', () => {
    const json = JSON.stringify({ allow: 5n, deny: 0n }, bigIntReplacer);
    expect(JSON.parse(json)).toEqual({ allow: '5', deny: '0' });
  });
});
