import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WS_EVENTS } from '@qufox/shared-types';
import { OutboxToWsSubscriber } from '../../../src/realtime/projection/outbox-to-ws.subscriber';
import type { WsEnvelope } from '../../../src/realtime/events/ws-event-envelope';

/**
 * S44 (FR-MN-01): 멘션 outbox→WS 변환 검증. 서버 내부 outbox eventType 은 dot
 * 표기(mention.received)지만 outbox→WS subscriber 가 PRD 카탈로그 콜론 wire
 * 이름(mention:new)으로 변환해 user:{userId} 룸에 emit + replay 적재해야 한다.
 *
 * vi.fn() 만 사용(외부 모킹 라이브러리 금지). gateway/replay/seq/messages/metrics
 * 의존성을 최소 스텁으로 주입한다.
 */
describe('OutboxToWsSubscriber.onMentionEvent — wire `mention:new` (S44 FR-MN-01)', () => {
  const emit = vi.fn();
  const to = vi.fn().mockReturnValue({ emit });
  const io = { to } as unknown as { to: typeof to };
  const replayAppend = vi.fn().mockResolvedValue(undefined);
  const metricLabels = { inc: vi.fn() };
  const wsEventsEmittedTotal = { labels: vi.fn().mockReturnValue(metricLabels) };

  function makeSubscriber(): OutboxToWsSubscriber {
    const gateway = { server: io } as unknown as ConstructorParameters<
      typeof OutboxToWsSubscriber
    >[0];
    const replay = { append: replayAppend } as unknown as ConstructorParameters<
      typeof OutboxToWsSubscriber
    >[1];
    const seq = { next: vi.fn() } as unknown as ConstructorParameters<
      typeof OutboxToWsSubscriber
    >[2];
    const messages = {} as unknown as ConstructorParameters<typeof OutboxToWsSubscriber>[3];
    const metrics = {
      wsEventsEmittedTotal,
      bucket: (_k: string, v: string) => v,
    } as unknown as ConstructorParameters<typeof OutboxToWsSubscriber>[4];
    return new OutboxToWsSubscriber(gateway, replay, seq, messages, metrics);
  }

  beforeEach(() => {
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    emit.mockClear();
    to.mockClear();
    replayAppend.mockClear();
    wsEventsEmittedTotal.labels.mockClear();
    metricLabels.inc.mockClear();
  });

  it('dot 이벤트(mention.received)를 콜론 wire(mention:new)로 변환해 user 룸에 emit', async () => {
    const sub = makeSubscriber();
    const env = {
      id: 'evt-1',
      type: 'mention.received',
      occurredAt: '2025-01-01T00:00:00.000Z',
      targetUserId: 'user-42',
      channelId: 'ch-1',
      messageId: 'm-1',
      actorId: 'actor-1',
      snippet: 'hello',
      createdAt: '2025-01-01T00:00:00.000Z',
      everyone: false,
      here: false,
    } as unknown as WsEnvelope;

    await sub.onMentionEvent(env);

    // user:{userId} 룸으로 라우팅.
    expect(to).toHaveBeenCalledWith('user:user-42');
    // wire 이벤트 이름은 콜론형 mention:new.
    expect(emit).toHaveBeenCalledTimes(1);
    const [emittedName, emittedPayload] = emit.mock.calls[0];
    expect(emittedName).toBe(WS_EVENTS.MENTION_NEW);
    expect(emittedName).toBe('mention:new');
    // 페이로드의 type 도 wire 이름으로 바뀐다(나머지 필드는 보존).
    expect((emittedPayload as { type: string }).type).toBe('mention:new');
    expect((emittedPayload as { messageId: string }).messageId).toBe('m-1');
    // replay 버퍼에도 wire 이름으로 적재.
    expect(replayAppend).toHaveBeenCalledWith(
      'user',
      'user-42',
      expect.objectContaining({ type: 'mention:new' }),
    );
    // 메트릭 라벨도 wire 이름.
    expect(wsEventsEmittedTotal.labels).toHaveBeenCalledWith('mention:new');
  });

  it('targetUserId 가 없으면 emit 하지 않는다(라우팅 키 부재)', async () => {
    const sub = makeSubscriber();
    const env = {
      id: 'evt-2',
      type: 'mention.received',
      occurredAt: '2025-01-01T00:00:00.000Z',
    } as unknown as WsEnvelope;
    await sub.onMentionEvent(env);
    expect(emit).not.toHaveBeenCalled();
  });
});
