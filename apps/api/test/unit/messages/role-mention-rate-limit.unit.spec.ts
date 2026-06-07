import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessagesService } from '../../../src/messages/messages.service';

/**
 * S88a review F11 (test) — per-role rate-limit 규칙 형태 단위 검증.
 *
 * per-role 10/5분 규칙은 int(실 Redis·실클럭)에서 user 5/분이 먼저 걸려 독립
 * 검증이 불가하다(time-advance 무의미). 대신 RateLimitService.enforce 를 vi.fn()
 * 스파이로 주입해, @role 멘션 송신 시 enforce 가 정확히
 *   [ {key:`mention:user:${authorId}`,        windowSec:60,  max:5},
 *     {key:`mention:role:${authorId}:${roleId}`, windowSec:300, max:10}, ... ]
 * 형태로 호출되는지 단언한다(키 포맷·window·max 회귀 가드). 다중 역할이면 역할별
 * 규칙 N개가 포함되는지도 확인한다. enforce 는 tx 전에 호출되므로 transaction 을
 * 던지게 해 그 시점에서 send 를 짧게 끊는다(enforce 호출 인자만 관찰).
 *
 * vi.fn() 스텁만 사용한다(하네스 규칙 — 외부 모킹 라이브러리 금지).
 */

const AUTHOR = '33333333-3333-4333-8333-333333333333';
const CHANNEL = '22222222-2222-4222-8222-222222222222';
const WS = '00000000-0000-4000-8000-00000000aaaa';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

type RoleRow = { id: string; name: string; mentionable: boolean };

function makeService(roles: RoleRow[], enforce: ReturnType<typeof vi.fn>) {
  const prisma = {
    // resolveMentionHandles / extractMentions: 알려진 user·channel 없음(빈 결과).
    user: { findMany: vi.fn().mockResolvedValue([]) },
    channel: { findMany: vi.fn().mockResolvedValue([]) },
    // extractRoleMentions: 알려진 워크스페이스 역할 목록.
    role: { findMany: vi.fn().mockResolvedValue(roles) },
    // enforce 는 tx 전에 호출되므로, tx 에 도달하면 그 자리에서 끊는다(관찰 완료).
    $transaction: vi.fn(async () => {
      throw new Error('reached tx — enforce already observed');
    }),
  } as unknown as ConstructorParameters<typeof MessagesService>[0];
  const outbox = { record: vi.fn() } as unknown as ConstructorParameters<typeof MessagesService>[1];
  const rate = { enforce } as unknown as ConstructorParameters<typeof MessagesService>[12];
  // constructor(prisma, outbox, metrics, threadSubscriptions, redis, unread, s3,
  //   presence, notifLevel, reminders, unfurl, audit, rate, channelAccess)
  const service = new MessagesService(
    prisma,
    outbox,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    rate,
  );
  return { service };
}

describe('MessagesService.send — per-role rate-limit rule shape (S88a F11)', () => {
  it('enforces user 5/60s + per-role 10/300s for a single mentionable role', async () => {
    const enforce = vi.fn().mockResolvedValue(undefined);
    const { service } = makeService([{ id: 'role-pm', name: 'PM', mentionable: true }], enforce);

    await expect(
      service.send({
        workspaceId: WS,
        channelId: CHANNEL,
        authorId: AUTHOR,
        content: 'heads up @PM',
        idempotencyKey: null,
      }),
    ).rejects.toThrow(/enforce already observed/);

    expect(enforce).toHaveBeenCalledTimes(1);
    expect(enforce).toHaveBeenCalledWith([
      { key: `mention:user:${AUTHOR}`, windowSec: 60, max: 5 },
      { key: `mention:role:${AUTHOR}:role-pm`, windowSec: 300, max: 10 },
    ]);
  });

  it('includes one per-role rule per distinct gated role (multi-role)', async () => {
    const enforce = vi.fn().mockResolvedValue(undefined);
    const { service } = makeService(
      [
        { id: 'role-pm', name: 'PM', mentionable: true },
        { id: 'role-devs', name: 'Devs', mentionable: true },
      ],
      enforce,
    );

    await expect(
      service.send({
        workspaceId: WS,
        channelId: CHANNEL,
        authorId: AUTHOR,
        content: '@PM and @Devs ship it',
        idempotencyKey: null,
      }),
    ).rejects.toThrow(/enforce already observed/);

    const rules = enforce.mock.calls[0][0] as Array<{
      key: string;
      windowSec: number;
      max: number;
    }>;
    // 첫 규칙은 user 규칙, 그 뒤로 역할별 규칙이 이어진다.
    expect(rules[0]).toEqual({ key: `mention:user:${AUTHOR}`, windowSec: 60, max: 5 });
    expect(rules).toContainEqual({
      key: `mention:role:${AUTHOR}:role-pm`,
      windowSec: 300,
      max: 10,
    });
    expect(rules).toContainEqual({
      key: `mention:role:${AUTHOR}:role-devs`,
      windowSec: 300,
      max: 10,
    });
    // user 규칙 1개 + 역할 규칙 2개 = 3.
    expect(rules).toHaveLength(3);
  });

  it('does NOT call enforce when no role is mentioned', async () => {
    const enforce = vi.fn().mockResolvedValue(undefined);
    const { service } = makeService([{ id: 'role-pm', name: 'PM', mentionable: true }], enforce);

    await expect(
      service.send({
        workspaceId: WS,
        channelId: CHANNEL,
        authorId: AUTHOR,
        content: 'just a plain message',
        idempotencyKey: null,
      }),
    ).rejects.toThrow(/enforce already observed/);

    expect(enforce).not.toHaveBeenCalled();
  });
});
