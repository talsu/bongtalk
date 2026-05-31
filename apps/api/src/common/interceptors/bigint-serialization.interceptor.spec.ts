import { describe, it, expect, beforeEach, vi } from 'vitest';
import { of, lastValueFrom } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { BigIntSerializationInterceptor } from './bigint-serialization.interceptor';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

function ctx(): ExecutionContext {
  // The interceptor never reads the context — it only transforms the
  // response stream. A minimal stub keeps the unit test framework-free.
  return {} as ExecutionContext;
}

function handlerOf(value: unknown): CallHandler {
  return { handle: () => of(value) };
}

describe('BigIntSerializationInterceptor (ADR-11)', () => {
  const interceptor = new BigIntSerializationInterceptor();

  it('serializes a top-level bigint to string', async () => {
    const out = await lastValueFrom(interceptor.intercept(ctx(), handlerOf(7n)));
    expect(out).toBe('7');
  });

  it('serializes nested allow/deny bitmasks (ChannelPermissionOverride DTO)', async () => {
    const dto = { channelId: 'c1', allow: 3n, deny: 0n };
    const out = await lastValueFrom(interceptor.intercept(ctx(), handlerOf(dto)));
    expect(out).toEqual({ channelId: 'c1', allow: '3', deny: '0' });
  });

  it('serializes seq bigint inside a message DTO array', async () => {
    const messages = [
      { id: 'm1', seq: 42n },
      { id: 'm2', seq: null },
    ];
    const out = await lastValueFrom(interceptor.intercept(ctx(), handlerOf(messages)));
    expect(out).toEqual([
      { id: 'm1', seq: '42' },
      { id: 'm2', seq: null },
    ]);
  });

  it('handles the ADMINISTRATOR 1<<63 bit without precision loss', async () => {
    const out = await lastValueFrom(interceptor.intercept(ctx(), handlerOf({ allow: 1n << 63n })));
    expect(out).toEqual({ allow: '9223372036854775808' });
  });

  it('preserves Date instances on the response', async () => {
    const when = new Date('2025-01-01T00:00:00Z');
    const out = (await lastValueFrom(
      interceptor.intercept(ctx(), handlerOf({ when, seq: 1n })),
    )) as { when: Date; seq: string };
    expect(out.when).toBeInstanceOf(Date);
    expect(out.seq).toBe('1');
  });

  it('passes through bigint-free payloads unchanged', async () => {
    const dto = { id: 'm1', content: 'hi', version: 0, deleted: false };
    const out = await lastValueFrom(interceptor.intercept(ctx(), handlerOf(dto)));
    expect(out).toEqual(dto);
  });
});
