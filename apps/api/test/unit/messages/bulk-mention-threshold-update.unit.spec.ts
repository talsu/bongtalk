import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessagesService } from '../../../src/messages/messages.service';
import { DomainError } from '../../../src/common/errors/domain-error';
import { ErrorCode } from '../../../src/common/errors/error-code.enum';

/**
 * S94 fix-forward (067 / FR-MSG-14 · HIGH-1): 편집(update) 경로 대규모 범위 멘션 임계값
 * enforce 단위 검증.
 *
 * 보안 갭: send() 의 안전망이 update() 에는 없어, 평문 메시지를 보낸 뒤 편집으로
 * @everyone/@here/@channel 을 주입하면 update() 가 broad fanout 을 임계값 확인 없이
 * 수행해 워크스페이스 전원 mass-ping 으로 send 게이트를 우회할 수 있었다.
 *
 * 수정: update() 가 게이트 통과 후·메시지 UPDATE(트랜잭션) 진입 **전**에,
 * **편집으로 새로 추가된** broad 멘션(이전 버전 mentions 에 없던 것)에 대해서만
 * enforceBulkMentionThreshold 를 호출한다.
 *
 * 검증 전략(send unit spec 패턴 재사용): 이전 mentions(message.findFirst)와 멤버
 * count(workspaceMember.count)를 스텁한 뒤 update 를 호출한다.
 *   - 신규 broad 추가 + 임계값 초과 + 미confirm → DomainError(409) throw (tx 미진입).
 *   - 신규 broad 추가 + confirm=true → 통과(이후 단계 $transaction 에서 끊음).
 *   - 신규 broad 추가 + 임계값 미만 → 통과(tx 진입).
 *   - 이미 같은 broad 가 있던 메시지 편집(신규추가 아님) → 체크 대상 아님(tx 진입·count 미호출).
 *   - 게이트 strip(권한 없음) → broadGated false 라 체크 대상 아님(tx 진입·findFirst/count 미호출).
 *
 * vi.fn() 스텁만 사용한다(하네스 규칙 — 외부 모킹 라이브러리 금지).
 */

const ACTOR = '33333333-3333-4333-8333-333333333333';
const CHANNEL = '22222222-2222-4222-8222-222222222222';
const MSG = '44444444-4444-4444-8444-444444444444';
const WS = '00000000-0000-4000-8000-00000000aaaa';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

/**
 * @param memberCount workspaceMember.count 스텁값.
 * @param prevMentions 편집 대상 메시지의 이전 mentions(편집 전 버전). null 이면 row 부재
 *   취급(필드 누락 → 신규추가로 판정). HIGH-1 임계값 enforce 는 트랜잭션 진입 전에
 *   message.findFirst 로 이전 mentions 를 읽는다.
 */
function makeService(
  memberCount: number,
  prevMentions: { everyone?: boolean; here?: boolean; channel?: boolean } | null,
) {
  const txMarker = new Error('reached tx — threshold check passed');
  const count = vi.fn().mockResolvedValue(memberCount);
  // 임계값 enforce 의 이전 mentions read(트랜잭션 진입 전 경량 조회).
  const findFirst = vi.fn().mockResolvedValue(
    prevMentions === null
      ? null
      : {
          mentions: {
            users: [],
            channels: [],
            everyone: prevMentions.everyone ?? false,
            here: prevMentions.here ?? false,
            channel: prevMentions.channel ?? false,
            roles: [],
          },
        },
  );
  const prisma = {
    // resolveMentionHandles / extractMentions / extractRoleMentions / label maps:
    // 알려진 user·channel·role 없음.
    user: { findMany: vi.fn().mockResolvedValue([]) },
    channel: { findMany: vi.fn().mockResolvedValue([]) },
    role: { findMany: vi.fn().mockResolvedValue([]) },
    // HIGH-1: 트랜잭션 진입 전 이전 mentions read.
    message: { findFirst },
    // 임계값 enforce 의 멤버 count 쿼리.
    workspaceMember: { count },
    // 임계값을 통과하면 tx 로 진입한다 — 그 자리에서 끊어 "통과" 를 관찰한다.
    $transaction: vi.fn(async () => {
      throw txMarker;
    }),
  } as unknown as ConstructorParameters<typeof MessagesService>[0];
  const outbox = { record: vi.fn() } as unknown as ConstructorParameters<typeof MessagesService>[1];
  const service = new MessagesService(prisma, outbox);
  return { service, count, findFirst, txMarker };
}

describe('MessagesService.update — bulk mention threshold enforce (S94 / FR-MSG-14 HIGH-1)', () => {
  it('편집으로 @channel 신규 추가 + 멤버수 ≥50 + 미confirm → 409 (mention=channel, tx 미진입)', async () => {
    // 이전 버전엔 broad 멘션 없음(평문) → @channel 은 신규 추가.
    const { service } = makeService(50, { channel: false });
    let caught: unknown;
    await service
      .update({
        workspaceId: WS,
        channelId: CHANNEL,
        msgId: MSG,
        actorId: ACTOR,
        content: 'heads up @channel',
        expectedVersion: 0,
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

  it('편집으로 @channel 신규 추가 + 멤버수 49(<50) → 임계값 통과(tx 진입)', async () => {
    const { service, txMarker } = makeService(49, { channel: false });
    await expect(
      service.update({
        workspaceId: WS,
        channelId: CHANNEL,
        msgId: MSG,
        actorId: ACTOR,
        content: 'heads up @channel',
        expectedVersion: 0,
        hasMentionChannel: true,
      }),
    ).rejects.toBe(txMarker);
  });

  it('편집으로 @everyone 신규 추가 + 멤버수 ≥6 + confirm=true → 임계값 통과(tx 진입)', async () => {
    const { service, txMarker } = makeService(100, { everyone: false });
    await expect(
      service.update({
        workspaceId: WS,
        channelId: CHANNEL,
        msgId: MSG,
        actorId: ACTOR,
        content: 'ping @everyone',
        expectedVersion: 0,
        hasMentionEveryone: true,
        bulkMentionConfirmed: true,
      }),
    ).rejects.toBe(txMarker);
  });

  it('편집으로 @everyone 신규 추가 + 멤버수 ≥6 + 미confirm → 409 (mention=everyone, threshold=6)', async () => {
    const { service } = makeService(6, { everyone: false });
    let caught: unknown;
    await service
      .update({
        workspaceId: WS,
        channelId: CHANNEL,
        msgId: MSG,
        actorId: ACTOR,
        content: 'ping @everyone',
        expectedVersion: 0,
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
  });

  it('이미 @channel 이 있던 메시지의 내용만 편집(신규추가 아님) → 재confirm 불요(tx 진입·count 미호출)', async () => {
    // 이전 버전에 이미 channel=true → 편집으로 @channel 이 유지돼도 신규추가가 아니다.
    const { service, count, txMarker } = makeService(1000, { channel: true });
    await expect(
      service.update({
        workspaceId: WS,
        channelId: CHANNEL,
        msgId: MSG,
        actorId: ACTOR,
        content: 'heads up @channel edited body',
        expectedVersion: 0,
        hasMentionChannel: true,
      }),
    ).rejects.toBe(txMarker);
    // 신규추가가 없으므로 멤버 count 쿼리는 발행되지 않는다.
    expect(count).not.toHaveBeenCalled();
  });

  it('편집 본문에 @channel 이 있어도 권한 없어 게이트 strip(hasMentionChannel=false) → 체크 대상 아님(tx 진입·findFirst/count 미호출)', async () => {
    const { service, count, findFirst, txMarker } = makeService(1000, { channel: false });
    await expect(
      service.update({
        workspaceId: WS,
        channelId: CHANNEL,
        msgId: MSG,
        actorId: ACTOR,
        content: 'heads up @channel',
        expectedVersion: 0,
        // hasMentionChannel 미지정 → 게이트가 channel=false 로 strip → 임계값 대상 아님.
      }),
    ).rejects.toBe(txMarker);
    // broadGated 가 전부 false 라 임계값 분기 자체에 진입하지 않는다 →
    // 이전 mentions read(findFirst)도 멤버 count 도 발행되지 않는다.
    expect(findFirst).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });

  it('범위 멘션 없는 일반 편집 → findFirst/count 미호출(tx 진입)', async () => {
    const { service, count, findFirst, txMarker } = makeService(1000, { channel: false });
    await expect(
      service.update({
        workspaceId: WS,
        channelId: CHANNEL,
        msgId: MSG,
        actorId: ACTOR,
        content: 'just a normal edit',
        expectedVersion: 0,
      }),
    ).rejects.toBe(txMarker);
    expect(findFirst).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });
});
