import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WS_EVENTS } from '@qufox/shared-types';
import { OutboxToWsSubscriber } from './outbox-to-ws.subscriber';
import { rooms } from '../rooms/room-names';
import type { WsEnvelope } from '../events/ws-event-envelope';

/**
 * S72 fix-forward (reviewer H1 = realtime BLOCKER): ws:workspace_deleted /
 * ws:workspace_restored 가 같은 EventEmitter2 이벤트로 disconnectSockets 하는
 * MembershipRevocationListener 보다 먼저 룸에 도달해야 한다(워크스페이스 스코프
 * 이벤트는 reconnect replay 대상이 아니므로 disconnect 가 먼저 이기면 영구 유실).
 *
 * 단위 검증: onWorkspaceEvent 가 콜론 wire emit 을 emitAndBuffer 의 (느린) Redis
 * append await 보다 *먼저* 동기 호출하는지 emit 호출 순서를 고정한다. replay.append
 * 가 resolve 되기 전(보류 중)에 이미 ws:workspace_deleted 가 emit 돼 있어야 한다.
 *
 * 추가: L3 — actorId/deleteAt 결손 envelope 는 빈 wire 를 무음 emit 하지 않고
 * 스킵한다(FE safeParse 무음 드롭 방지).
 */
beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

type EmitCall = { event: string; payload: unknown; room: string };

function makeSubscriber() {
  const emitCalls: EmitCall[] = [];
  // replay.append 가 보류(pending) 상태로 머무는 deferred — 이 동안 emit 이 이미
  // 일어났는지 확인해 "emit 이 첫 await 이전(동기)에 발생" 을 검증한다.
  let resolveAppend: (() => void) | null = null;
  const appendGate = new Promise<void>((r) => {
    resolveAppend = r;
  });

  const ioTo = vi.fn((room: string) => ({
    emit: (event: string, payload: unknown) => {
      emitCalls.push({ event, payload, room });
    },
  }));
  const io = { to: ioTo };
  const gateway = { server: io } as never;

  const replayAppend = vi.fn(async () => {
    await appendGate; // 보류 — onWorkspaceEvent 가 여기서 첫 await 에 멈춘다.
  });
  const replay = { append: replayAppend } as never;
  const seq = { next: vi.fn(async () => 1) } as never;
  const messages = {} as never;
  const badges = {} as never;
  const prisma = {} as never;
  const metrics = {
    wsEventsEmittedTotal: { labels: () => ({ inc: vi.fn() }) },
    wsMessageFanoutLatencySeconds: { observe: vi.fn() },
    bucket: (_k: string, v: string) => v,
  } as never;

  // S86: workspace lifecycle 경로는 push enqueue 를 타지 않으므로 빈 스텁이면 충분하다.
  const presence = { lastActivityMs: vi.fn(async () => null) } as never;
  const pushQueue = { enqueue: vi.fn(async () => undefined) } as never;

  const sub = new OutboxToWsSubscriber(
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
  return { sub, emitCalls, resolveAppend: () => resolveAppend?.() };
}

describe('OutboxToWsSubscriber — workspace lifecycle wire ordering (FR-W15 / H1)', () => {
  it('emits ws:workspace_deleted to the workspace room BEFORE the first await (emitAndBuffer replay append)', async () => {
    const { sub, emitCalls, resolveAppend } = makeSubscriber();
    const env = {
      id: 'ev-1',
      type: 'workspace.deleted',
      occurredAt: '2025-01-01T00:00:00.000Z',
      workspaceId: 'ws-1',
      actorId: 'owner',
      deleteAt: '2025-01-31T00:00:00.000Z',
    } as unknown as WsEnvelope;

    // 핸들러를 시작하되 replay.append 게이트에서 await 에 멈추게 둔다(아직 resolve 안 함).
    const pending = sub.onWorkspaceEvent(env);
    // 마이크로태스크 한 번 비워 동기 emit 이 실행되게 한다.
    await Promise.resolve();

    // 첫 await 가 보류 중인데도 콜론 wire 가 이미 룸에 emit 돼 있어야 한다(disconnect 보다 선도).
    const deletedEmit = emitCalls.find((c) => c.event === WS_EVENTS.WORKSPACE_DELETED);
    expect(deletedEmit).toBeDefined();
    expect(deletedEmit?.room).toBe(rooms.workspace('ws-1'));
    expect(deletedEmit?.payload).toEqual({
      workspaceId: 'ws-1',
      actorId: 'owner',
      deleteAt: '2025-01-31T00:00:00.000Z',
    });
    // 콜론 wire 가 dot emitAndBuffer(workspace.deleted) 보다 먼저 호출됐는지 순서 고정.
    const idxWire = emitCalls.findIndex((c) => c.event === WS_EVENTS.WORKSPACE_DELETED);
    const idxDot = emitCalls.findIndex((c) => c.event === 'workspace.deleted');
    expect(idxWire).toBeGreaterThanOrEqual(0);
    // dot 은 emitAndBuffer 안 — append await 뒤이므로 이 시점엔 아직 없어야 한다.
    expect(idxDot).toBe(-1);

    resolveAppend();
    await pending;
  });

  it('emits ws:workspace_restored synchronously before the first await', async () => {
    const { sub, emitCalls, resolveAppend } = makeSubscriber();
    const env = {
      id: 'ev-2',
      type: 'workspace.restored',
      occurredAt: '2025-01-01T00:00:00.000Z',
      workspaceId: 'ws-1',
      actorId: 'owner',
    } as unknown as WsEnvelope;

    const pending = sub.onWorkspaceEvent(env);
    await Promise.resolve();

    const restoredEmit = emitCalls.find((c) => c.event === WS_EVENTS.WORKSPACE_RESTORED);
    expect(restoredEmit).toBeDefined();
    expect(restoredEmit?.payload).toEqual({ workspaceId: 'ws-1', actorId: 'owner' });

    resolveAppend();
    await pending;
  });

  it('skips the colon wire emit (no empty-string wire) when actorId/deleteAt are missing (L3)', async () => {
    const { sub, emitCalls, resolveAppend } = makeSubscriber();
    const env = {
      id: 'ev-3',
      type: 'workspace.deleted',
      occurredAt: '2025-01-01T00:00:00.000Z',
      workspaceId: 'ws-1',
      // actorId / deleteAt intentionally absent
    } as unknown as WsEnvelope;

    const pending = sub.onWorkspaceEvent(env);
    await Promise.resolve();

    // 빈 문자열 wire 를 emit 하지 않는다(FE safeParse 무음 드롭 방지) — 콜론 emit 자체가 없어야.
    expect(emitCalls.find((c) => c.event === WS_EVENTS.WORKSPACE_DELETED)).toBeUndefined();

    resolveAppend();
    await pending;
  });
});
