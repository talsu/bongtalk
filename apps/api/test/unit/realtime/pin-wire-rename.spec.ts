import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WS_EVENTS } from '@qufox/shared-types';
import { OutboxToWsSubscriber } from '../../../src/realtime/projection/outbox-to-ws.subscriber';
import type { WsEnvelope } from '../../../src/realtime/events/ws-event-envelope';

/**
 * S50 (D10 · FR-PS-02/06): 핀 outbox→WS 변환 검증. 서버 내부 outbox eventType 은 dot
 * 표기(message.pin.toggled)지만 outbox→WS subscriber 가 pinnedAt 의 null 여부로
 * channel:pin_added / channel:pin_removed 콜론 wire 로 분기·변환해 채널 룸에 emit
 * 해야 한다. vi.fn() 만 사용(외부 모킹 라이브러리 금지).
 */
describe('OutboxToWsSubscriber.onMessageEvent — wire `channel:pin_*` (S50 FR-PS-02/06)', () => {
  const emit = vi.fn();
  const to = vi.fn().mockReturnValue({ emit });
  const io = { to } as unknown as { to: typeof to };
  const replayAppend = vi.fn().mockResolvedValue(undefined);
  const seqNext = vi.fn().mockResolvedValue(7);
  const metricLabels = { inc: vi.fn() };
  const wsEventsEmittedTotal = { labels: vi.fn().mockReturnValue(metricLabels) };
  const wsMessageFanoutLatencySeconds = { observe: vi.fn() };

  function makeSubscriber(): OutboxToWsSubscriber {
    const gateway = { server: io } as unknown as ConstructorParameters<
      typeof OutboxToWsSubscriber
    >[0];
    const replay = { append: replayAppend } as unknown as ConstructorParameters<
      typeof OutboxToWsSubscriber
    >[1];
    const seq = { next: seqNext } as unknown as ConstructorParameters<
      typeof OutboxToWsSubscriber
    >[2];
    const messages = {} as unknown as ConstructorParameters<typeof OutboxToWsSubscriber>[3];
    const badges = {} as unknown as ConstructorParameters<typeof OutboxToWsSubscriber>[4];
    // S70 fix-forward (M-3): subscriber 가 application.received 를 ADMIN+ user 룸으로만
    // 보내기 위해 PrismaService 를 주입받는다. 핀 경로는 prisma 를 쓰지 않으므로 빈 mock.
    const prisma = {} as unknown as ConstructorParameters<typeof OutboxToWsSubscriber>[5];
    // S86: 핀 경로는 push enqueue 를 타지 않으므로 빈 스텁이면 충분하다.
    const presence = {
      lastActivityMs: vi.fn().mockResolvedValue(null),
    } as unknown as ConstructorParameters<typeof OutboxToWsSubscriber>[6];
    const pushQueue = {
      enqueue: vi.fn().mockResolvedValue(undefined),
    } as unknown as ConstructorParameters<typeof OutboxToWsSubscriber>[7];
    const metrics = {
      wsEventsEmittedTotal,
      wsMessageFanoutLatencySeconds,
      bucket: (_k: string, v: string) => v,
    } as unknown as ConstructorParameters<typeof OutboxToWsSubscriber>[8];
    return new OutboxToWsSubscriber(
      gateway,
      replay,
      seq,
      messages,
      badges,
      prisma,
      presence,
      pushQueue,
      metrics,
    );
  }

  beforeEach(() => {
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    emit.mockClear();
    to.mockClear();
    replayAppend.mockClear();
    seqNext.mockClear();
    wsEventsEmittedTotal.labels.mockClear();
    metricLabels.inc.mockClear();
  });

  it('pinnedAt 비-null → channel:pin_added 로 변환(systemMessageId/used 동봉) + 채널 룸 emit', async () => {
    const sub = makeSubscriber();
    const env = {
      id: 'evt-1',
      type: 'message.pin.toggled',
      occurredAt: '2025-01-01T00:00:00.000Z',
      channelId: 'ch-1',
      workspaceId: 'ws-1',
      actorId: 'actor-1',
      messageId: 'm-1',
      pinnedAt: '2025-01-01T00:00:00.000Z',
      pinnedBy: 'actor-1',
      systemMessageId: 'sys-1',
      used: 3,
    } as unknown as WsEnvelope;

    await sub.onMessageEvent(env);

    expect(to).toHaveBeenCalledWith('channel:ch-1');
    expect(emit).toHaveBeenCalledTimes(1);
    const [name, payload] = emit.mock.calls[0];
    expect(name).toBe(WS_EVENTS.CHANNEL_PIN_ADDED);
    expect(name).toBe('channel:pin_added');
    const p = payload as {
      type: string;
      channelId: string;
      messageId: string;
      systemMessageId: string | null;
      used?: number;
      pinnedBy: string;
    };
    expect(p.type).toBe('channel:pin_added');
    expect(p.messageId).toBe('m-1');
    expect(p.systemMessageId).toBe('sys-1');
    expect(p.used).toBe(3);
    expect(p.pinnedBy).toBe('actor-1');
  });

  it('pinnedAt null → channel:pin_removed 로 변환(unpinnedById 동봉) + 채널 룸 emit', async () => {
    const sub = makeSubscriber();
    const env = {
      id: 'evt-2',
      type: 'message.pin.toggled',
      occurredAt: '2025-01-01T00:00:00.000Z',
      channelId: 'ch-1',
      workspaceId: 'ws-1',
      actorId: 'actor-9',
      messageId: 'm-2',
      pinnedAt: null,
      pinnedBy: null,
    } as unknown as WsEnvelope;

    await sub.onMessageEvent(env);

    expect(emit).toHaveBeenCalledTimes(1);
    const [name, payload] = emit.mock.calls[0];
    expect(name).toBe(WS_EVENTS.CHANNEL_PIN_REMOVED);
    expect(name).toBe('channel:pin_removed');
    const p = payload as { type: string; messageId: string; unpinnedById: string | null };
    expect(p.type).toBe('channel:pin_removed');
    expect(p.messageId).toBe('m-2');
    expect(p.unpinnedById).toBe('actor-9');
  });
});
