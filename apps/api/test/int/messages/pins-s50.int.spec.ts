/**
 * S50 (D10 핀 메시지) 통합 검증 — 실 Postgres + Redis(testcontainer).
 *
 * 커버리지(게이트 원문 숫자):
 *   - FR-PS-01: 멤버 핀 허용(READ ACL 통과 멤버) + 시스템 메시지 핀 불가(400).
 *   - FR-PS-02: 핀 추가 시 SYSTEM_PIN 시스템 메시지 자동 삽입.
 *   - FR-PS-04: hard cap 55 초과 시도 → 423 MESSAGE_PIN_CAP_EXCEEDED.
 *   - FR-PS-06: 핀된 메시지 소프트 삭제 cascade — listPins 에서 즉시 제외.
 *   - FR-PS-14: 이미 핀된 메시지 재핀 → 200 + 현재 상태(idempotent).
 *
 * 핀/시스템 메시지/cascade 는 모두 메시지 저장과 동일 tx 에서 처리되므로 DB 를
 * 직접 조회해 권위 검증한다(WS drain 없이).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { MsgIntEnv, ORIGIN, bearer, seedMessageStack, setupMsgIntEnv } from './helpers';

let env: MsgIntEnv;
let stack: Awaited<ReturnType<typeof seedMessageStack>>;

async function sendMessage(token: string, content: string): Promise<string> {
  const res = await request(env.baseUrl)
    .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
    .set('origin', ORIGIN)
    .set(bearer(token))
    .send({ content });
  if (res.status !== 201) throw new Error(`send failed: ${res.status} ${res.text}`);
  return res.body.message.id as string;
}

function pin(token: string, msgId: string) {
  return request(env.baseUrl)
    .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages/${msgId}/pin`)
    .set('origin', ORIGIN)
    .set(bearer(token))
    .send();
}

function unpin(token: string, msgId: string) {
  return request(env.baseUrl)
    .delete(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages/${msgId}/pin`)
    .set('origin', ORIGIN)
    .set(bearer(token))
    .send();
}

function listPins(token: string) {
  return request(env.baseUrl)
    .get(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages/pins`)
    .set('origin', ORIGIN)
    .set(bearer(token));
}

function pinCount(token: string) {
  return request(env.baseUrl)
    .get(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages/pins/count`)
    .set('origin', ORIGIN)
    .set(bearer(token));
}

beforeAll(async () => {
  env = await setupMsgIntEnv();
  stack = await seedMessageStack(env.baseUrl);
}, 300_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

beforeEach(async () => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  await env.prisma.message.deleteMany({ where: { channelId: stack.channelId } });
  await env.prisma.outboxEvent.deleteMany({});
});

describe('S50 D10 pins — FR-PS-01 권한·핀 가능 조건', () => {
  it('FR-PS-01: 일반 멤버도 메시지를 핀할 수 있다(READ ACL 통과 멤버 전체 허용)', async () => {
    const msgId = await sendMessage(stack.member.accessToken, 'pin me');
    const res = await pin(stack.member.accessToken, msgId);
    expect(res.status).toBe(200);
    expect(res.body.pinnedAt).toBeTruthy();
    expect(res.body.pinnedBy).toBe(stack.member.userId);
  });

  it('FR-PS-01: 비멤버는 가드 체인에서 막힌다(핀 불가)', async () => {
    const msgId = await sendMessage(stack.member.accessToken, 'hi');
    const res = await pin(stack.nonMember.accessToken, msgId);
    expect(res.status).toBeGreaterThanOrEqual(403);
  });

  it('FR-PS-01: 시스템 메시지(SYSTEM_PIN)는 핀할 수 없다 → 400', async () => {
    // 일반 메시지를 핀하면 SYSTEM_PIN 시스템 메시지가 자동 생성된다.
    const msgId = await sendMessage(stack.member.accessToken, 'target');
    expect((await pin(stack.member.accessToken, msgId)).status).toBe(200);
    const sysRow = await env.prisma.message.findFirst({
      where: { channelId: stack.channelId, type: 'SYSTEM_PIN' },
    });
    expect(sysRow).toBeTruthy();
    const res = await pin(stack.member.accessToken, sysRow!.id);
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe('VALIDATION_FAILED');
  });
});

describe('S50 D10 pins — FR-PS-02 SYSTEM_PIN 삽입', () => {
  it('FR-PS-02: 핀 추가 시 채널 스트림에 SYSTEM_PIN 시스템 메시지가 자동 삽입된다', async () => {
    const msgId = await sendMessage(stack.member.accessToken, 'pin target');
    await pin(stack.member.accessToken, msgId);
    const sys = await env.prisma.message.findFirst({
      where: { channelId: stack.channelId, type: 'SYSTEM_PIN' },
    });
    expect(sys).toBeTruthy();
    expect(sys!.authorType).toBe('SYSTEM');
    expect(sys!.content).toContain('고정');
  });
});

describe('S50 D10 pins — FR-PS-04 hard cap 55', () => {
  it('FR-PS-04: hard cap(55) 초과 시도 → 423 MESSAGE_PIN_CAP_EXCEEDED', async () => {
    // 55개를 직접 핀 상태로 시드(SYSTEM_PIN 폭주 방지 위해 DB 직접 — cap 검사만 본다).
    const now = new Date('2025-01-01T00:00:00.000Z').getTime();
    const rows = Array.from({ length: 55 }, (_, i) => ({
      id: crypto.randomUUID(),
      channelId: stack.channelId,
      authorId: stack.member.userId,
      content: `pinned ${i}`,
      contentPlain: `pinned ${i}`,
      createdAt: new Date(now + i * 1000),
      pinnedAt: new Date(now + i * 1000),
      pinnedBy: stack.member.userId,
    }));
    await env.prisma.message.createMany({ data: rows });
    // 한 개 더 핀 시도 → 423.
    const extra = await sendMessage(stack.member.accessToken, '56th');
    const res = await pin(stack.member.accessToken, extra);
    expect(res.status).toBe(423);
    expect(res.body.errorCode).toBe('MESSAGE_PIN_CAP_EXCEEDED');
  });

  it('FR-PS-04: pins/count 경량 엔드포인트가 현재 핀 수를 돌려준다', async () => {
    const a = await sendMessage(stack.member.accessToken, 'a');
    const b = await sendMessage(stack.member.accessToken, 'b');
    await pin(stack.member.accessToken, a);
    await pin(stack.member.accessToken, b);
    const res = await pinCount(stack.member.accessToken);
    expect(res.status).toBe(200);
    expect(res.body.used).toBe(2);
    expect(res.body.cap).toBe(50);
  });
});

describe('S50 D10 pins — FR-PS-06 소프트삭제 cascade', () => {
  it('FR-PS-06: 핀된 메시지 소프트 삭제 시 핀이 자동 제거된다(listPins 에서 제외)', async () => {
    const msgId = await sendMessage(stack.member.accessToken, 'pin then delete');
    await pin(stack.member.accessToken, msgId);
    // 삭제 전: 목록에 포함.
    const before = await listPins(stack.member.accessToken);
    expect(before.body.items.some((m: { id: string }) => m.id === msgId)).toBe(true);
    // 삭제(작성자 본인).
    const del = await request(env.baseUrl)
      .delete(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages/${msgId}`)
      .set('origin', ORIGIN)
      .set(bearer(stack.member.accessToken))
      .send();
    expect(del.status).toBe(204);
    // 삭제 후: 핀 표식 null + listPins 에서 제외.
    const row = await env.prisma.message.findUnique({ where: { id: msgId } });
    expect(row!.pinnedAt).toBeNull();
    const after = await listPins(stack.member.accessToken);
    expect(after.body.items.some((m: { id: string }) => m.id === msgId)).toBe(false);
    // cascade pin_removed outbox(MESSAGE_PIN_TOGGLED, pinnedAt=null)가 기록됨.
    const pinEvents = await env.prisma.outboxEvent.findMany({
      where: { eventType: 'message.pin.toggled' },
    });
    const removed = pinEvents.find(
      (e) =>
        (e.payload as { messageId?: string; pinnedAt?: string | null }).messageId === msgId &&
        (e.payload as { pinnedAt?: string | null }).pinnedAt === null,
    );
    expect(removed).toBeTruthy();
  });
});

describe('S50 D10 pins — FR-PS-14 idempotent', () => {
  it('FR-PS-14: 이미 핀된 메시지 재핀 → 200 + 현재 상태(SYSTEM_PIN 중복 삽입 없음)', async () => {
    const msgId = await sendMessage(stack.member.accessToken, 'idem');
    const first = await pin(stack.member.accessToken, msgId);
    expect(first.status).toBe(200);
    const second = await pin(stack.member.accessToken, msgId);
    expect(second.status).toBe(200);
    expect(second.body.pinnedBy).toBe(stack.member.userId);
    // SYSTEM_PIN 시스템 메시지는 1개만(재핀이 또 삽입하지 않음).
    const sysCount = await env.prisma.message.count({
      where: { channelId: stack.channelId, type: 'SYSTEM_PIN' },
    });
    expect(sysCount).toBe(1);
  });

  it('FR-PS-14: 미고정 상태 unpin → 200(idempotent)', async () => {
    const msgId = await sendMessage(stack.member.accessToken, 'unpin idem');
    const res = await unpin(stack.member.accessToken, msgId);
    expect(res.status).toBe(200);
    expect(res.body.pinnedAt).toBeNull();
  });
});
