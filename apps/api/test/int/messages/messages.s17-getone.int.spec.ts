import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Permission } from '../../../src/auth/permissions';
import {
  bearer,
  seedMessageStack,
  setupMsgIntEnv,
  type MsgIntEnv,
  type SeededStack,
} from './helpers';

/**
 * S17 BLOCKER (read-path bypass) — `MessagesController.getOne` 회귀 spec.
 *
 * list 경로에만 걸려 있던 visibleFrom 하한선 + 차단 마스킹이 워크스페이스
 * 스코프 DIRECT 채널의 단건 조회(`GET /workspaces/:id/channels/:chid/messages/:msgId`)
 * 에서도 적용되는지 검증한다.
 *
 *  - visibleFrom 이전 메시지 단건 → list 와 동일하게 404(MESSAGE_NOT_FOUND).
 *  - 차단 author 의 메시지 단건 → placeholder 마스킹.
 *  - 비-DIRECT(TEXT) 채널 단건 → 무영향(회귀 없음).
 */
describe('S17 getOne visibleFrom/mask (workspace-scoped DIRECT, int)', () => {
  let env: MsgIntEnv;
  let stack: SeededStack;

  beforeAll(async () => {
    env = await setupMsgIntEnv();
    stack = await seedMessageStack(env.baseUrl);
  }, 240_000);

  afterAll(async () => {
    await env.stop();
  }, 60_000);

  /**
   * 워크스페이스 스코프 1:1 DIRECT 채널을 DB 에 직접 만든다(S16/027-era 형태):
   * type=DIRECT, isPrivate, 두 참여자에게 USER-level ALLOW override.
   */
  async function makeWorkspaceDirect(owner: string, peer: string, tag: string): Promise<string> {
    const mask = Permission.READ | Permission.WRITE_MESSAGE | Permission.DELETE_OWN_MESSAGE;
    const channel = await env.prisma.channel.create({
      data: {
        workspaceId: stack.workspaceId,
        // (workspaceId, name) 는 UNIQUE — 테스트별 tag 로 충돌을 피한다.
        name: `dm:${tag}:${owner}:${peer}`,
        type: 'DIRECT',
        isPrivate: true,
        position: 1000,
        overrides: {
          create: [
            { principalType: 'USER', principalId: owner, allowMask: mask },
            { principalType: 'USER', principalId: peer, allowMask: mask },
          ],
        },
      },
      select: { id: true },
    });
    return channel.id;
  }

  async function seedMsg(channelId: string, authorId: string, content: string): Promise<string> {
    const row = await env.prisma.message.create({
      data: {
        channelId,
        authorId,
        content,
        contentPlain: content,
        contentRaw: content,
        mentions: { users: [], channels: [], everyone: false, here: false },
      },
      select: { id: true },
    });
    return row.id;
  }

  it('BLOCKER: visibleFrom 이전 메시지 단건 조회는 404 (list 와 일관)', async () => {
    const channelId = await makeWorkspaceDirect(stack.owner.userId, stack.member.userId, 'vf');
    const older = await seedMsg(channelId, stack.member.userId, 'older than visibleFrom');
    const olderRow = await env.prisma.message.findUnique({ where: { id: older } });
    const newer = await seedMsg(channelId, stack.member.userId, 'newer than visibleFrom');

    // owner 의 visibleFrom 을 older 와 newer 사이로 올린다.
    await env.prisma.channelPermissionOverride.updateMany({
      where: { channelId, principalType: 'USER', principalId: stack.owner.userId },
      data: { visibleFrom: new Date(olderRow!.createdAt.getTime() + 1) },
    });

    // older 단건 → 404.
    const belowRes = await request(env.baseUrl)
      .get(`/workspaces/${stack.workspaceId}/channels/${channelId}/messages/${older}`)
      .set(bearer(stack.owner.accessToken));
    expect(belowRes.status).toBe(404);
    expect(belowRes.body.errorCode).toBe('MESSAGE_NOT_FOUND');

    // newer 단건 → 200(가시 영역) — 회귀 없음.
    const okRes = await request(env.baseUrl)
      .get(`/workspaces/${stack.workspaceId}/channels/${channelId}/messages/${newer}`)
      .set(bearer(stack.owner.accessToken));
    expect(okRes.status).toBe(200);
    expect(okRes.body.message.id).toBe(newer);

    // member(visibleFrom 미설정)는 older 도 200 — 비-blocker 회귀 가드.
    const peerRes = await request(env.baseUrl)
      .get(`/workspaces/${stack.workspaceId}/channels/${channelId}/messages/${older}`)
      .set(bearer(stack.member.accessToken));
    expect(peerRes.status).toBe(200);
  });

  it('BLOCKER: 차단 author 의 메시지 단건은 placeholder 로 마스킹된다', async () => {
    const channelId = await makeWorkspaceDirect(stack.owner.userId, stack.member.userId, 'mask');
    const peerMsg = await seedMsg(channelId, stack.member.userId, 'peer message to mask');

    // owner 가 member 를 차단(Friendship BLOCKED, blocker=requester).
    await env.prisma.friendship.create({
      data: {
        requesterId: stack.owner.userId,
        addresseeId: stack.member.userId,
        status: 'BLOCKED',
      },
    });

    const res = await request(env.baseUrl)
      .get(`/workspaces/${stack.workspaceId}/channels/${channelId}/messages/${peerMsg}`)
      .set(bearer(stack.owner.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.message.content).toBe('[차단된 사용자의 메시지]');
    expect(res.body.message.contentRaw).toBe('[차단된 사용자의 메시지]');

    // member(차단자 아님)는 자기 메시지를 원문 그대로 본다 — 단방향 마스킹.
    const peerView = await request(env.baseUrl)
      .get(`/workspaces/${stack.workspaceId}/channels/${channelId}/messages/${peerMsg}`)
      .set(bearer(stack.member.accessToken));
    expect(peerView.body.message.content).toBe('peer message to mask');
  });

  it('REGRESSION: 비-DIRECT(TEXT) 채널 단건 조회는 visibleFrom/mask 무영향', async () => {
    // seedMessageStack 이 만든 TEXT 채널에 owner 가 메시지 전송.
    const send = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set(bearer(stack.owner.accessToken))
      .send({ content: 'plain text channel message' });
    expect(send.status).toBe(201);
    const msgId = send.body.message.id as string;

    const res = await request(env.baseUrl)
      .get(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages/${msgId}`)
      .set(bearer(stack.member.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.message.content).toBe('plain text channel message');
  });
});
