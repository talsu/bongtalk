import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
 * S80 (D15 / FR-SC-06) int spec — Reminder REST(`/users/me/reminders`).
 *
 * 실 Postgres + 실 Redis testcontainer + 전체 Nest 앱. GET/POST/DELETE 와 본인 스코프
 * 격리(타인 리마인더 미노출·삭제 불가 404)를 검증한다.
 */
describe('Reminder REST /users/me/reminders (int)', () => {
  let env: MsgIntEnv;
  let stack: SeededStack;

  beforeAll(async () => {
    env = await setupMsgIntEnv();
    stack = await seedMessageStack(env.baseUrl);
  }, 240_000);

  afterAll(async () => {
    await env?.stop();
  });

  it('POST 로 리마인더를 만들고 GET 으로 본다', async () => {
    const created = await request(env.baseUrl)
      .post('/users/me/reminders')
      .set('origin', ORIGIN)
      .set(bearer(stack.owner.accessToken))
      .send({ when: 'tomorrow 9am', message: '아침 운동', channelId: null });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('PENDING');
    expect(created.body.message).toBe('아침 운동');

    const list = await request(env.baseUrl)
      .get('/users/me/reminders')
      .set('origin', ORIGIN)
      .set(bearer(stack.owner.accessToken));
    expect(list.status).toBe(200);
    const ids = (list.body.items as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toContain(created.body.id);
  });

  it('POST 파싱 실패 → 400 REMINDER_PARSE_FAILED', async () => {
    const res = await request(env.baseUrl)
      .post('/users/me/reminders')
      .set('origin', ORIGIN)
      .set(bearer(stack.owner.accessToken))
      .send({ when: 'zzz qqq', message: 'xx', channelId: null });
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe('REMINDER_PARSE_FAILED');
  });

  it('DELETE 로 본인 리마인더를 취소한다(status=CANCELLED)', async () => {
    const created = await request(env.baseUrl)
      .post('/users/me/reminders')
      .set('origin', ORIGIN)
      .set(bearer(stack.owner.accessToken))
      .send({ when: 'in 2 hours', message: '취소될 리마인더', channelId: null });
    expect(created.status).toBe(201);
    const del = await request(env.baseUrl)
      .delete(`/users/me/reminders/${created.body.id}`)
      .set('origin', ORIGIN)
      .set(bearer(stack.owner.accessToken));
    expect(del.status).toBe(204);
    const row = await env.prisma.reminder.findUnique({ where: { id: created.body.id } });
    expect(row?.status).toBe('CANCELLED');
  });

  it('타인 리마인더는 DELETE 할 수 없다(404 REMINDER_NOT_FOUND)', async () => {
    const created = await request(env.baseUrl)
      .post('/users/me/reminders')
      .set('origin', ORIGIN)
      .set(bearer(stack.owner.accessToken))
      .send({ when: 'in 1 hour', message: '소유자 전용', channelId: null });
    const del = await request(env.baseUrl)
      .delete(`/users/me/reminders/${created.body.id}`)
      .set('origin', ORIGIN)
      .set(bearer(stack.member.accessToken));
    expect(del.status).toBe(404);
    expect(del.body.errorCode).toBe('REMINDER_NOT_FOUND');
  });

  it('타인 리마인더는 GET 목록에 보이지 않는다(본인 스코프)', async () => {
    const ownerCreated = await request(env.baseUrl)
      .post('/users/me/reminders')
      .set('origin', ORIGIN)
      .set(bearer(stack.owner.accessToken))
      .send({ when: 'in 3 hours', message: '오너 전용 항목', channelId: null });
    const memberList = await request(env.baseUrl)
      .get('/users/me/reminders')
      .set('origin', ORIGIN)
      .set(bearer(stack.member.accessToken));
    const ids = (memberList.body.items as Array<{ id: string }>).map((r) => r.id);
    expect(ids).not.toContain(ownerCreated.body.id);
  });
});
