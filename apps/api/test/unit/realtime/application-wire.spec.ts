import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WS_EVENTS } from '@qufox/shared-types';
import { OutboxToWsSubscriber } from '../../../src/realtime/projection/outbox-to-ws.subscriber';
import type { WsEnvelope } from '../../../src/realtime/events/ws-event-envelope';

/**
 * S70 fix-forward (security M-3): application.received 는 ADMIN+(OWNER/ADMIN) user 룸으로만
 * emit 해야 한다(일반 멤버에게 applicantId/applicantName 노출 차단). application.reviewed 는
 * 신청자 본인 user 룸으로만 emit(기존 동작). vi.fn() 만 사용(외부 모킹 라이브러리 금지).
 */
describe('OutboxToWsSubscriber.onApplicationEvent — application.received ADMIN+ 전용 (S70 M-3)', () => {
  const emit = vi.fn();
  const to = vi.fn().mockReturnValue({ emit });
  const io = { to } as unknown as { to: typeof to };
  const replayAppend = vi.fn().mockResolvedValue(undefined);
  const metricLabels = { inc: vi.fn() };
  const wsEventsEmittedTotal = { labels: vi.fn().mockReturnValue(metricLabels) };

  function makeSubscriber(adminUserIds: string[]): OutboxToWsSubscriber {
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
    const badges = {} as unknown as ConstructorParameters<typeof OutboxToWsSubscriber>[4];
    const prisma = {
      workspaceMember: {
        findMany: vi.fn().mockResolvedValue(adminUserIds.map((userId) => ({ userId }))),
      },
    } as unknown as ConstructorParameters<typeof OutboxToWsSubscriber>[5];
    const metrics = {
      wsEventsEmittedTotal,
      bucket: (_k: string, v: string) => v,
    } as unknown as ConstructorParameters<typeof OutboxToWsSubscriber>[6];
    return new OutboxToWsSubscriber(gateway, replay, seq, messages, badges, prisma, metrics);
  }

  beforeEach(() => {
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    emit.mockClear();
    to.mockClear();
    replayAppend.mockClear();
    wsEventsEmittedTotal.labels.mockClear();
    metricLabels.inc.mockClear();
  });

  it('application.received 를 ADMIN+ user 룸으로만 emit 한다(워크스페이스 룸 fanout 안 함)', async () => {
    const sub = makeSubscriber(['admin-1', 'admin-2']);
    const env = {
      id: 'evt-1',
      type: 'application.received',
      occurredAt: '2025-01-01T00:00:00.000Z',
      workspaceId: 'ws-1',
      applicationId: 'app-1',
      applicantId: 'applicant-1',
      applicantName: 'Alice',
    } as unknown as WsEnvelope;

    await sub.onApplicationEvent(env);

    // 두 ADMIN user 룸으로만 라우팅(workspace:ws-1 룸 fanout 없음).
    expect(to).toHaveBeenCalledWith('user:admin-1');
    expect(to).toHaveBeenCalledWith('user:admin-2');
    expect(to).not.toHaveBeenCalledWith('workspace:ws-1');
    expect(emit).toHaveBeenCalledTimes(2);
    const [name, payload] = emit.mock.calls[0];
    expect(name).toBe(WS_EVENTS.APPLICATION_RECEIVED);
    expect((payload as { applicantId: string }).applicantId).toBe('applicant-1');
    expect((payload as { applicantName: string }).applicantName).toBe('Alice');
  });

  it('ADMIN+ 가 없으면 아무 emit 도 하지 않는다', async () => {
    const sub = makeSubscriber([]);
    const env = {
      id: 'evt-2',
      type: 'application.received',
      occurredAt: '2025-01-01T00:00:00.000Z',
      workspaceId: 'ws-1',
      applicationId: 'app-1',
      applicantId: 'applicant-1',
      applicantName: 'Alice',
    } as unknown as WsEnvelope;

    await sub.onApplicationEvent(env);
    expect(emit).not.toHaveBeenCalled();
  });

  it('application.reviewed 는 신청자 본인 user 룸으로만 emit 한다', async () => {
    const sub = makeSubscriber(['admin-1']);
    const env = {
      id: 'evt-3',
      type: 'application.reviewed',
      occurredAt: '2025-01-01T00:00:00.000Z',
      workspaceId: 'ws-1',
      applicationId: 'app-1',
      applicantId: 'applicant-1',
      status: 'approved',
      reviewNote: null,
      interviewChannelId: null,
    } as unknown as WsEnvelope;

    await sub.onApplicationEvent(env);

    expect(to).toHaveBeenCalledWith('user:applicant-1');
    expect(to).not.toHaveBeenCalledWith('workspace:ws-1');
    const [name, payload] = emit.mock.calls[0];
    expect(name).toBe(WS_EVENTS.APPLICATION_REVIEWED);
    expect((payload as { status: string }).status).toBe('approved');
    // 신청자 본인 user 룸에 replay 버퍼 적재.
    expect(replayAppend).toHaveBeenCalledWith(
      'user',
      'applicant-1',
      expect.objectContaining({ type: WS_EVENTS.APPLICATION_REVIEWED }),
    );
  });
});
