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
 * S80 (D15 / FR-SC-04·05·06) int spec — 슬래시 커맨드 실행 엔드포인트.
 *
 * 실 Postgres + 실 Redis testcontainer + 전체 Nest 앱(supertest). 검증:
 *   - IN_CHANNEL(/shrug·/me): 텍스트 변환 후 MessagesService.send 로 메시지 생성 → messageId 반환.
 *   - EPHEMERAL(/away·/dnd·/status): presence/status 전환 + 발신자 전용 확인(채널 미게시).
 *   - /remind: 자연어 파싱 성공 → Reminder 행 + BullMQ 잡(bullJobId) / 실패 → EPHEMERAL error.
 *   - 멱등성(같은 idempotencyKey 재호출 → 같은 결과·중복 메시지 없음).
 *   - 비멤버 차단(WorkspaceMemberGuard 404) + 채널 접근(ChannelAccessGuard).
 *
 * 헬퍼는 messages int 헬퍼(setupMsgIntEnv/seedMessageStack)를 재사용한다 — signup 직후
 * emailVerified=true 마킹 포함(S66 무회귀).
 */
describe('POST /workspaces/:wsId/channels/:chid/slash-commands/execute (int)', () => {
  let env: MsgIntEnv;
  let stack: SeededStack;

  const execUrl = (s: SeededStack) =>
    `/workspaces/${s.workspaceId}/channels/${s.channelId}/slash-commands/execute`;

  beforeAll(async () => {
    env = await setupMsgIntEnv();
    stack = await seedMessageStack(env.baseUrl);
  }, 240_000);

  afterAll(async () => {
    await env?.stop();
  });

  it('FR-SC-04: /shrug → IN_CHANNEL 메시지를 생성한다', async () => {
    const res = await request(env.baseUrl)
      .post(execUrl(stack))
      .set('origin', ORIGIN)
      .set(bearer(stack.member.accessToken))
      .send({ command: 'shrug', text: '안녕', idempotencyKey: randomUUID() });
    expect(res.status).toBe(201);
    expect(res.body.responseType).toBe('IN_CHANNEL');
    expect(typeof res.body.messageId).toBe('string');
    // 생성된 메시지의 본문이 sigil 을 포함한다.
    const msg = await env.prisma.message.findUnique({ where: { id: res.body.messageId } });
    expect(msg?.content).toContain('¯\\_(ツ)_/¯');
    expect(msg?.authorId).toBe(stack.member.userId);
  });

  it('FR-SC-04 / FR-RC18: /me → 이탤릭(_..._) 본문으로 메시지를 생성한다', async () => {
    const res = await request(env.baseUrl)
      .post(execUrl(stack))
      .set('origin', ORIGIN)
      .set(bearer(stack.member.accessToken))
      .send({ command: 'me', text: 'waves', idempotencyKey: randomUUID() });
    expect(res.status).toBe(201);
    expect(res.body.responseType).toBe('IN_CHANNEL');
    const msg = await env.prisma.message.findUnique({ where: { id: res.body.messageId } });
    expect(msg?.content).toBe('_waves_');
  });

  it('FR-SC-05: /away → EPHEMERAL 확인 + presencePreference=auto(채널 미게시)', async () => {
    const before = await env.prisma.message.count({ where: { channelId: stack.channelId } });
    const res = await request(env.baseUrl)
      .post(execUrl(stack))
      .set('origin', ORIGIN)
      .set(bearer(stack.member.accessToken))
      .send({ command: 'away', text: '', idempotencyKey: randomUUID() });
    expect(res.status).toBe(201);
    expect(res.body.responseType).toBe('EPHEMERAL');
    expect(typeof res.body.content).toBe('string');
    // 채널에 메시지가 추가되지 않았다(EPHEMERAL).
    const after = await env.prisma.message.count({ where: { channelId: stack.channelId } });
    expect(after).toBe(before);
  });

  it('FR-SC-05: /dnd 30m → EPHEMERAL + presencePreference=dnd', async () => {
    const res = await request(env.baseUrl)
      .post(execUrl(stack))
      .set('origin', ORIGIN)
      .set(bearer(stack.member.accessToken))
      .send({ command: 'dnd', text: '30m', idempotencyKey: randomUUID() });
    expect(res.status).toBe(201);
    expect(res.body.responseType).toBe('EPHEMERAL');
    const user = await env.prisma.user.findUnique({ where: { id: stack.member.userId } });
    expect(user?.presencePreference).toBe('dnd');
  });

  it('FR-SC-05: /dnd 잘못된 기간 → EPHEMERAL error', async () => {
    const res = await request(env.baseUrl)
      .post(execUrl(stack))
      .set('origin', ORIGIN)
      .set(bearer(stack.member.accessToken))
      .send({ command: 'dnd', text: 'forever', idempotencyKey: randomUUID() });
    expect(res.status).toBe(201);
    expect(res.body.responseType).toBe('EPHEMERAL');
    expect(res.body.error).toBe(true);
  });

  it('FR-SC-05: /status → EPHEMERAL + 커스텀 상태 설정', async () => {
    const res = await request(env.baseUrl)
      .post(execUrl(stack))
      .set('origin', ORIGIN)
      .set(bearer(stack.member.accessToken))
      .send({ command: 'status', text: ':coffee: 휴식 중', idempotencyKey: randomUUID() });
    expect(res.status).toBe(201);
    expect(res.body.responseType).toBe('EPHEMERAL');
    const user = await env.prisma.user.findUnique({ where: { id: stack.member.userId } });
    expect(user?.customStatus).toBe('휴식 중');
    expect(user?.customStatusEmoji).toBe(':coffee:');
  });

  it('FR-SC-06: /remind 파싱 성공 → Reminder 행 + bullJobId', async () => {
    const res = await request(env.baseUrl)
      .post(execUrl(stack))
      .set('origin', ORIGIN)
      .set(bearer(stack.member.accessToken))
      .send({ command: 'remind', text: 'in 30 minutes 회의 준비', idempotencyKey: randomUUID() });
    expect(res.status).toBe(201);
    expect(res.body.responseType).toBe('EPHEMERAL');
    expect(res.body.error).toBeFalsy();
    const reminders = await env.prisma.reminder.findMany({
      where: { userId: stack.member.userId, message: '회의 준비' },
    });
    expect(reminders).toHaveLength(1);
    expect(reminders[0].status).toBe('PENDING');
    expect(reminders[0].channelId).toBe(stack.channelId);
    expect(reminders[0].bullJobId).toBe(`reminder:${reminders[0].id}`);
  });

  it('FR-SC-06: /remind 파싱 실패 → EPHEMERAL error(구문 예시)', async () => {
    const res = await request(env.baseUrl)
      .post(execUrl(stack))
      .set('origin', ORIGIN)
      .set(bearer(stack.member.accessToken))
      .send({ command: 'remind', text: 'asdf qwer zxcv', idempotencyKey: randomUUID() });
    expect(res.status).toBe(201);
    expect(res.body.responseType).toBe('EPHEMERAL');
    expect(res.body.error).toBe(true);
    expect(res.body.content).toContain('/remind');
  });

  it('멱등성: 같은 idempotencyKey 로 /shrug 재호출 → 같은 messageId(중복 메시지 없음)', async () => {
    const key = randomUUID();
    const r1 = await request(env.baseUrl)
      .post(execUrl(stack))
      .set('origin', ORIGIN)
      .set(bearer(stack.member.accessToken))
      .send({ command: 'shrug', text: '멱등', idempotencyKey: key });
    const r2 = await request(env.baseUrl)
      .post(execUrl(stack))
      .set('origin', ORIGIN)
      .set(bearer(stack.member.accessToken))
      .send({ command: 'shrug', text: '멱등', idempotencyKey: key });
    expect(r1.body.messageId).toBe(r2.body.messageId);
    const count = await env.prisma.message.count({
      where: { channelId: stack.channelId, authorId: stack.member.userId, content: { contains: '멱등' } },
    });
    expect(count).toBe(1);
  });

  it('알 수 없는 커맨드 → 404 SLASH_COMMAND_UNKNOWN', async () => {
    const res = await request(env.baseUrl)
      .post(execUrl(stack))
      .set('origin', ORIGIN)
      .set(bearer(stack.member.accessToken))
      .send({ command: 'doesnotexist', text: '', idempotencyKey: randomUUID() });
    expect(res.status).toBe(404);
    expect(res.body.errorCode).toBe('SLASH_COMMAND_UNKNOWN');
  });

  it('비멤버는 실행할 수 없다(WorkspaceMemberGuard 404)', async () => {
    const res = await request(env.baseUrl)
      .post(execUrl(stack))
      .set('origin', ORIGIN)
      .set(bearer(stack.nonMember.accessToken))
      .send({ command: 'shrug', text: 'x', idempotencyKey: randomUUID() });
    expect(res.status).toBe(404);
  });

  it('존재하지 않는 채널 → 404(ChannelAccessGuard)', async () => {
    const res = await request(env.baseUrl)
      .post(
        `/workspaces/${stack.workspaceId}/channels/${randomUUID()}/slash-commands/execute`,
      )
      .set('origin', ORIGIN)
      .set(bearer(stack.member.accessToken))
      .send({ command: 'shrug', text: 'x', idempotencyKey: randomUUID() });
    expect(res.status).toBe(404);
  });

  it('인증 없이 호출하면 401', async () => {
    const res = await request(env.baseUrl)
      .post(execUrl(stack))
      .set('origin', ORIGIN)
      .send({ command: 'shrug', text: 'x', idempotencyKey: randomUUID() });
    expect([401, 403]).toContain(res.status);
  });
});
