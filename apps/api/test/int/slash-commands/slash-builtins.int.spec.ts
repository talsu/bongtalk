import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  bearer,
  ORIGIN,
  seedMessageStack,
  setupMsgIntEnv,
  type MsgIntEnv,
  type SeededStack,
} from '../messages/helpers';

/**
 * S81a (D15 / FR-SC-08) int spec — 빌트인 서버 액션 슬래시 커맨드.
 *
 * 실 Postgres + 실 Redis testcontainer + 전체 Nest 앱(supertest). 검증:
 *   - /nick   : WorkspaceMemberProfile.nickname 영속(본인).
 *   - /topic  : MANAGE_CHANNEL(OWNER/ADMIN) 성공 + Channel.topic 갱신 + SYSTEM 메시지,
 *               MEMBER 는 EPHEMERAL error(권한 거부, 채널 미게시).
 *   - /mute   : UserChannelMute 영속(본인).
 *   - /kick   : KICK_MEMBERS(OWNER) 성공 + WorkspaceMember 삭제, MEMBER 는 EPHEMERAL error.
 *   - /invite : MANAGE_CHANNEL(OWNER) 성공 + ChannelPermissionOverride(USER READ ALLOW) 생성.
 *   - 대상 해석 실패(@미존재) → EPHEMERAL error(채널 미게시).
 *   - 클라이언트 전용(/collapse·/search 등) → 422 SLASH_COMMAND_NOT_EXECUTABLE.
 *
 * 헬퍼는 messages int 헬퍼(setupMsgIntEnv/seedMessageStack)를 재사용한다(emailVerified=true 포함).
 */
describe('POST .../slash-commands/execute — S81a built-ins (int)', () => {
  let env: MsgIntEnv;
  let stack: SeededStack;

  const execUrl = (s: SeededStack) =>
    `/workspaces/${s.workspaceId}/channels/${s.channelId}/slash-commands/execute`;

  const exec = (actorToken: string, command: string, text: string) =>
    request(env.baseUrl)
      .post(execUrl(stack))
      .set('origin', ORIGIN)
      .set(bearer(actorToken))
      .send({ command, text, idempotencyKey: randomUUID() });

  beforeAll(async () => {
    env = await setupMsgIntEnv();
    stack = await seedMessageStack(env.baseUrl);
  }, 240_000);

  afterAll(async () => {
    await env?.stop();
  });

  it('FR-SC-08: /nick → WorkspaceMemberProfile.nickname 영속(본인)', async () => {
    const res = await exec(stack.member.accessToken, 'nick', '냐옹이');
    expect(res.status).toBe(201);
    expect(res.body.responseType).toBe('EPHEMERAL');
    expect(res.body.error).toBeUndefined();
    const row = await env.prisma.workspaceMemberProfile.findUnique({
      where: {
        workspaceId_userId: { workspaceId: stack.workspaceId, userId: stack.member.userId },
      },
    });
    expect(row?.nickname).toBe('냐옹이');
  });

  it('FR-SC-08: /topic (OWNER=MANAGE_CHANNEL) → Channel.topic 갱신 + SYSTEM 메시지', async () => {
    const before = await env.prisma.message.count({ where: { channelId: stack.channelId } });
    const res = await exec(stack.owner.accessToken, 'topic', '새 채널 토픽');
    expect(res.status).toBe(201);
    expect(res.body.responseType).toBe('EPHEMERAL');
    expect(res.body.error).toBeUndefined();
    const ch = await env.prisma.channel.findUnique({ where: { id: stack.channelId } });
    expect(ch?.topic).toBe('새 채널 토픽');
    // 토픽 변경 SYSTEM 메시지가 채널에 발행됐다(update 내부 발행).
    const after = await env.prisma.message.count({ where: { channelId: stack.channelId } });
    expect(after).toBeGreaterThan(before);
  });

  it('FR-SC-08: /topic (MEMBER=권한 없음) → EPHEMERAL error 이고 토픽 미변경', async () => {
    const ch0 = await env.prisma.channel.findUnique({ where: { id: stack.channelId } });
    const res = await exec(stack.member.accessToken, 'topic', '멤버가 바꾸려 함');
    expect(res.status).toBe(201);
    expect(res.body.responseType).toBe('EPHEMERAL');
    expect(res.body.error).toBe(true);
    const ch1 = await env.prisma.channel.findUnique({ where: { id: stack.channelId } });
    expect(ch1?.topic).toBe(ch0?.topic ?? null);
  });

  it('FR-SC-08: /mute → UserChannelMute 영속(본인)', async () => {
    const res = await exec(stack.member.accessToken, 'mute', '');
    expect(res.status).toBe(201);
    expect(res.body.responseType).toBe('EPHEMERAL');
    expect(res.body.error).toBeUndefined();
    const mute = await env.prisma.userChannelMute.findUnique({
      where: { userId_channelId: { userId: stack.member.userId, channelId: stack.channelId } },
    });
    expect(mute?.isMuted).toBe(true);
  });

  it('FR-SC-08: /invite (OWNER=MANAGE_CHANNEL) @member → ChannelPermissionOverride(USER READ ALLOW)', async () => {
    const res = await exec(stack.owner.accessToken, 'invite', `@${stack.member.username}`);
    expect(res.status).toBe(201);
    expect(res.body.responseType).toBe('EPHEMERAL');
    expect(res.body.error).toBeUndefined();
    const override = await env.prisma.channelPermissionOverride.findFirst({
      where: {
        channelId: stack.channelId,
        principalType: 'USER',
        principalId: stack.member.userId,
      },
    });
    expect(override).not.toBeNull();
    // READ(0x01) ALLOW 비트가 켜져 있어야 한다(채널 멤버십).
    expect(Number(override?.allowMask ?? 0n) & 0x01).toBe(0x01);
  });

  it('FR-SC-08: /invite 대상 해석 실패(@미존재) → EPHEMERAL error', async () => {
    const res = await exec(stack.owner.accessToken, 'invite', '@nonexistent_handle_zzz');
    expect(res.status).toBe(201);
    expect(res.body.responseType).toBe('EPHEMERAL');
    expect(res.body.error).toBe(true);
  });

  it('FR-SC-08: /kick (MEMBER=권한 없음) @admin → EPHEMERAL error 이고 멤버 유지', async () => {
    const res = await exec(stack.member.accessToken, 'kick', `@${stack.admin.username}`);
    expect(res.status).toBe(201);
    expect(res.body.responseType).toBe('EPHEMERAL');
    expect(res.body.error).toBe(true);
    const adminMember = await env.prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: { workspaceId: stack.workspaceId, userId: stack.admin.userId },
      },
    });
    expect(adminMember).not.toBeNull();
  });

  it('FR-SC-08: /kick (OWNER=KICK_MEMBERS) @member → WorkspaceMember 삭제', async () => {
    const res = await exec(stack.owner.accessToken, 'kick', `@${stack.member.username}`);
    expect(res.status).toBe(201);
    expect(res.body.responseType).toBe('EPHEMERAL');
    expect(res.body.error).toBeUndefined();
    const kicked = await env.prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: { workspaceId: stack.workspaceId, userId: stack.member.userId },
      },
    });
    expect(kicked).toBeNull();
  });

  it('FR-SC-08: 클라이언트 전용 /collapse → 422 SLASH_COMMAND_NOT_EXECUTABLE', async () => {
    const res = await exec(stack.owner.accessToken, 'collapse', '');
    expect(res.status).toBe(422);
    expect(res.body.errorCode ?? res.body.code).toBe('SLASH_COMMAND_NOT_EXECUTABLE');
  });

  it('FR-SC-08: 클라이언트 전용 /search → 422 SLASH_COMMAND_NOT_EXECUTABLE', async () => {
    const res = await exec(stack.owner.accessToken, 'search', '키워드');
    expect(res.status).toBe(422);
    expect(res.body.errorCode ?? res.body.code).toBe('SLASH_COMMAND_NOT_EXECUTABLE');
  });
});
