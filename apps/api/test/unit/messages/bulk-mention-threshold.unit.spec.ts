import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessagesService } from '../../../src/messages/messages.service';
import { DomainError } from '../../../src/common/errors/domain-error';
import { ErrorCode } from '../../../src/common/errors/error-code.enum';

/**
 * S94 (067 / FR-MSG-14): 서버 측 대규모 범위 멘션 임계값 enforce 단위 검증.
 *
 * send() 가 게이트 통과 직후·메시지 INSERT(트랜잭션) 전에 enforceBulkMentionThreshold
 * 를 호출한다. 게이트를 살아남은 특수멘션(@everyone/@here/@channel)이 채널 멤버수
 * 임계값(@everyone ≥6 · @here/@channel ≥50)을 넘고 bulkMentionConfirmed 미동봉이면
 * BULK_MENTION_CONFIRM_REQUIRED(409)를 던진다.
 *
 * 검증 전략: 멤버 count 를 스텁한 뒤 send 를 호출한다.
 *   - 임계값 초과 + 미confirm → DomainError(409) throw (tx 미진입).
 *   - 임계값 초과 + confirm=true → 통과(이후 단계 $transaction 에서 끊음).
 *   - 임계값 미만 → 통과(tx 진입).
 *   - 게이트 strip(권한 없음) → broadGated false 라 체크 대상 아님(tx 진입).
 *
 * vi.fn() 스텁만 사용한다(하네스 규칙 — 외부 모킹 라이브러리 금지).
 */

const AUTHOR = '33333333-3333-4333-8333-333333333333';
const CHANNEL = '22222222-2222-4222-8222-222222222222';
const WS = '00000000-0000-4000-8000-00000000aaaa';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

function makeService(memberCount: number) {
  const txMarker = new Error('reached tx — threshold check passed');
  const count = vi.fn().mockResolvedValue(memberCount);
  const prisma = {
    // resolveMentionHandles / extractMentions: 알려진 user·channel·role 없음.
    user: { findMany: vi.fn().mockResolvedValue([]) },
    channel: { findMany: vi.fn().mockResolvedValue([]) },
    role: { findMany: vi.fn().mockResolvedValue([]) },
    // 임계값 enforce 의 멤버 count 쿼리.
    workspaceMember: { count },
    // 임계값을 통과하면 tx 로 진입한다 — 그 자리에서 끊어 "통과" 를 관찰한다.
    $transaction: vi.fn(async () => {
      throw txMarker;
    }),
  } as unknown as ConstructorParameters<typeof MessagesService>[0];
  const outbox = { record: vi.fn() } as unknown as ConstructorParameters<typeof MessagesService>[1];
  const service = new MessagesService(prisma, outbox);
  return { service, count, txMarker };
}

describe('MessagesService.send — bulk mention threshold enforce (S94 / FR-MSG-14)', () => {
  it('@everyone + 멤버수 ≥6 + 미confirm → 409 BULK_MENTION_CONFIRM_REQUIRED (tx 미진입)', async () => {
    const { service, count } = makeService(6);
    let caught: unknown;
    await service
      .send({
        workspaceId: WS,
        channelId: CHANNEL,
        authorId: AUTHOR,
        content: 'ping @everyone',
        idempotencyKey: null,
        mentionsHint: { everyone: true },
        hasMentionEveryone: true,
      })
      .catch((e) => {
        caught = e;
      });
    expect(caught).toBeInstanceOf(DomainError);
    expect((caught as DomainError).code).toBe(ErrorCode.BULK_MENTION_CONFIRM_REQUIRED);
    expect((caught as DomainError).details).toMatchObject({
      mention: 'everyone',
      count: 6,
      threshold: 6,
    });
    expect(count).toHaveBeenCalledTimes(1);
  });

  it('@everyone + 멤버수 5(<6) → 임계값 통과(tx 진입)', async () => {
    const { service, txMarker } = makeService(5);
    await expect(
      service.send({
        workspaceId: WS,
        channelId: CHANNEL,
        authorId: AUTHOR,
        content: 'ping @everyone',
        idempotencyKey: null,
        mentionsHint: { everyone: true },
        hasMentionEveryone: true,
      }),
    ).rejects.toBe(txMarker);
  });

  it('@everyone + 멤버수 ≥6 + confirm=true → 임계값 통과(tx 진입)', async () => {
    const { service, txMarker } = makeService(100);
    await expect(
      service.send({
        workspaceId: WS,
        channelId: CHANNEL,
        authorId: AUTHOR,
        content: 'ping @everyone',
        idempotencyKey: null,
        mentionsHint: { everyone: true },
        hasMentionEveryone: true,
        bulkMentionConfirmed: true,
      }),
    ).rejects.toBe(txMarker);
  });

  it('@channel + 멤버수 ≥50 + 미confirm → 409 (mention=channel, threshold=50)', async () => {
    const { service } = makeService(50);
    let caught: unknown;
    await service
      .send({
        workspaceId: WS,
        channelId: CHANNEL,
        authorId: AUTHOR,
        content: 'heads up @channel',
        idempotencyKey: null,
        mentionsHint: { channel: true },
        hasMentionChannel: true,
      })
      .catch((e) => {
        caught = e;
      });
    expect(caught).toBeInstanceOf(DomainError);
    expect((caught as DomainError).code).toBe(ErrorCode.BULK_MENTION_CONFIRM_REQUIRED);
    expect((caught as DomainError).details).toMatchObject({
      mention: 'channel',
      count: 50,
      threshold: 50,
    });
  });

  it('@channel + 멤버수 49(<50) → 임계값 통과(tx 진입)', async () => {
    const { service, txMarker } = makeService(49);
    await expect(
      service.send({
        workspaceId: WS,
        channelId: CHANNEL,
        authorId: AUTHOR,
        content: 'heads up @channel',
        idempotencyKey: null,
        mentionsHint: { channel: true },
        hasMentionChannel: true,
      }),
    ).rejects.toBe(txMarker);
  });

  it('@channel 이지만 권한 없어 게이트 strip(hasMentionChannel=false) → 체크 대상 아님(tx 진입·count 미호출)', async () => {
    const { service, count, txMarker } = makeService(1000);
    await expect(
      service.send({
        workspaceId: WS,
        channelId: CHANNEL,
        authorId: AUTHOR,
        content: 'heads up @channel',
        idempotencyKey: null,
        mentionsHint: { channel: true },
        // hasMentionChannel 미지정 → 게이트가 channel=false 로 strip → 임계값 대상 아님.
      }),
    ).rejects.toBe(txMarker);
    expect(count).not.toHaveBeenCalled();
  });

  it('@here + 멤버수 ≥50 + 미confirm → 409 (mention=here, threshold=50)', async () => {
    const { service } = makeService(80);
    let caught: unknown;
    await service
      .send({
        workspaceId: WS,
        channelId: CHANNEL,
        authorId: AUTHOR,
        content: 'online folks @here',
        idempotencyKey: null,
        mentionsHint: { here: true },
        hasMentionChannel: true,
      })
      .catch((e) => {
        caught = e;
      });
    expect(caught).toBeInstanceOf(DomainError);
    expect((caught as DomainError).code).toBe(ErrorCode.BULK_MENTION_CONFIRM_REQUIRED);
    expect((caught as DomainError).details).toMatchObject({ mention: 'here', threshold: 50 });
  });

  it('범위 멘션 없는 일반 메시지 → count 미조회(tx 진입)', async () => {
    const { service, count, txMarker } = makeService(1000);
    await expect(
      service.send({
        workspaceId: WS,
        channelId: CHANNEL,
        authorId: AUTHOR,
        content: 'just a normal message',
        idempotencyKey: null,
      }),
    ).rejects.toBe(txMarker);
    expect(count).not.toHaveBeenCalled();
  });
});
