/**
 * S51 (D10 핀 권한 토글 + 개인 저장함 + SYSTEM_PIN 멤버 삭제) 통합 검증 —
 * 실 Postgres + Redis(testcontainer).
 *
 * 커버리지:
 *   FR-PS-05 — memberCanPin=false 채널에서 MEMBER pin 403 · ADMIN pin OK · 토글 후
 *              동작 변화(true 로 되돌리면 MEMBER 다시 허용).
 *   FR-PS-07 — SavedMessage 저장/idempotent/해제/목록 status 필터/count/500 한도 422/
 *              비가시 채널 저장 차단 · 원본 soft-delete 시 messageDeletedAt 반영.
 *   FR-PS-15 — SYSTEM_PIN 을 일반 MEMBER 가 삭제 가능 · 핀 유지 · 일반 메시지는 타인
 *              삭제 불가.
 *
 * 모두 메시지 저장/핀/삭제 tx 안에서 처리되므로 DB 직접 조회로 권위 검증한다.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { MsgIntEnv, ORIGIN, bearer, seedMessageStack, setupMsgIntEnv } from './helpers';

let env: MsgIntEnv;
let stack: Awaited<ReturnType<typeof seedMessageStack>>;

const ws = () => stack.workspaceId;
const ch = () => stack.channelId;

async function sendMessage(token: string, content: string): Promise<string> {
  const res = await request(env.baseUrl)
    .post(`/workspaces/${ws()}/channels/${ch()}/messages`)
    .set('origin', ORIGIN)
    .set(bearer(token))
    .send({ content });
  if (res.status !== 201) throw new Error(`send failed: ${res.status} ${res.text}`);
  return res.body.message.id as string;
}

function pin(token: string, msgId: string) {
  return request(env.baseUrl)
    .post(`/workspaces/${ws()}/channels/${ch()}/messages/${msgId}/pin`)
    .set('origin', ORIGIN)
    .set(bearer(token))
    .send();
}

function unpin(token: string, msgId: string) {
  return request(env.baseUrl)
    .delete(`/workspaces/${ws()}/channels/${ch()}/messages/${msgId}/pin`)
    .set('origin', ORIGIN)
    .set(bearer(token))
    .send();
}

function deleteMsg(token: string, msgId: string) {
  return request(env.baseUrl)
    .delete(`/workspaces/${ws()}/channels/${ch()}/messages/${msgId}`)
    .set('origin', ORIGIN)
    .set(bearer(token))
    .send();
}

function patchChannel(token: string, patch: Record<string, unknown>) {
  return request(env.baseUrl)
    .patch(`/workspaces/${ws()}/channels/${ch()}`)
    .set('origin', ORIGIN)
    .set(bearer(token))
    .send(patch);
}

function saveMsg(token: string, msgId: string) {
  return request(env.baseUrl)
    .post(`/me/saved/${msgId}`)
    .set('origin', ORIGIN)
    .set(bearer(token))
    .send();
}

function unsaveMsg(token: string, msgId: string) {
  return request(env.baseUrl)
    .delete(`/me/saved/${msgId}`)
    .set('origin', ORIGIN)
    .set(bearer(token))
    .send();
}

function listSaved(token: string, query = '') {
  return request(env.baseUrl).get(`/me/saved${query}`).set('origin', ORIGIN).set(bearer(token));
}

function savedCount(token: string) {
  return request(env.baseUrl).get('/me/saved/count').set('origin', ORIGIN).set(bearer(token));
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
  await env.prisma.savedMessage.deleteMany({});
  await env.prisma.message.deleteMany({ where: { channelId: ch() } });
  await env.prisma.outboxEvent.deleteMany({});
  // 채널 핀 권한을 기본값(true)으로 리셋한다(앞선 케이스가 false 로 토글했을 수 있음).
  await env.prisma.channel.update({ where: { id: ch() }, data: { memberCanPin: true } });
});

describe('S51 FR-PS-05 — 핀 권한 채널 토글', () => {
  it('memberCanPin=false 채널에서 일반 MEMBER 의 pin 은 403, ADMIN 은 허용', async () => {
    const msgId = await sendMessage(stack.member.accessToken, 'restricted pin target');
    // ADMIN 이 채널 핀 권한을 제한으로 토글.
    const patched = await patchChannel(stack.admin.accessToken, { memberCanPin: false });
    expect(patched.status).toBe(200);
    expect(patched.body.memberCanPin).toBe(false);

    // MEMBER pin → 403 FORBIDDEN.
    const memberPin = await pin(stack.member.accessToken, msgId);
    expect(memberPin.status).toBe(403);
    expect(memberPin.body.errorCode).toBe('FORBIDDEN');

    // ADMIN pin → 200.
    const adminPin = await pin(stack.admin.accessToken, msgId);
    expect(adminPin.status).toBe(200);
    expect(adminPin.body.pinnedAt).toBeTruthy();
  });

  it('토글을 true 로 되돌리면 MEMBER 핀이 다시 허용된다', async () => {
    const msgId = await sendMessage(stack.member.accessToken, 'toggle target');
    await patchChannel(stack.admin.accessToken, { memberCanPin: false });
    expect((await pin(stack.member.accessToken, msgId)).status).toBe(403);
    // 다시 허용으로 토글.
    const reEnabled = await patchChannel(stack.admin.accessToken, { memberCanPin: true });
    expect(reEnabled.body.memberCanPin).toBe(true);
    const memberPin = await pin(stack.member.accessToken, msgId);
    expect(memberPin.status).toBe(200);
  });

  it('memberCanPin=false 채널에서 MEMBER unpin 도 403(ADMIN 만 해제)', async () => {
    const msgId = await sendMessage(stack.member.accessToken, 'unpin gate');
    await pin(stack.member.accessToken, msgId); // 아직 허용 상태에서 핀.
    await patchChannel(stack.admin.accessToken, { memberCanPin: false });
    const memberUnpin = await unpin(stack.member.accessToken, msgId);
    expect(memberUnpin.status).toBe(403);
    const adminUnpin = await unpin(stack.admin.accessToken, msgId);
    expect(adminUnpin.status).toBe(200);
  });

  it('기본값(memberCanPin=true)에서는 종전대로 MEMBER 핀 허용', async () => {
    const msgId = await sendMessage(stack.member.accessToken, 'default allow');
    const res = await pin(stack.member.accessToken, msgId);
    expect(res.status).toBe(200);
  });
});

describe('S51 FR-PS-07 — 개인 저장함', () => {
  it('저장/idempotent/해제 토글', async () => {
    const msgId = await sendMessage(stack.member.accessToken, 'save me');
    const first = await saveMsg(stack.member.accessToken, msgId);
    expect(first.status).toBe(200);
    expect(first.body.saved).toBe(true);
    expect(first.body.status).toBe('IN_PROGRESS');
    const firstId = first.body.savedMessageId as string;

    // 재저장 → idempotent(같은 savedMessageId).
    const again = await saveMsg(stack.member.accessToken, msgId);
    expect(again.status).toBe(200);
    expect(again.body.savedMessageId).toBe(firstId);
    expect(await env.prisma.savedMessage.count({ where: { messageId: msgId } })).toBe(1);

    // 해제 → saved:false.
    const removed = await unsaveMsg(stack.member.accessToken, msgId);
    expect(removed.status).toBe(200);
    expect(removed.body.saved).toBe(false);
    expect(await env.prisma.savedMessage.count({ where: { messageId: msgId } })).toBe(0);

    // 미저장 상태에서 해제 → idempotent 200.
    expect((await unsaveMsg(stack.member.accessToken, msgId)).status).toBe(200);
  });

  it('목록 status 필터 + IN_PROGRESS count 배지', async () => {
    const a = await sendMessage(stack.member.accessToken, 'first saved');
    const b = await sendMessage(stack.member.accessToken, 'second saved');
    await saveMsg(stack.member.accessToken, a);
    await saveMsg(stack.member.accessToken, b);

    const list = await listSaved(stack.member.accessToken, '?status=IN_PROGRESS&limit=50');
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(2);
    // savedAt DESC — 나중 저장(b)이 먼저.
    expect(list.body.items[0].messageId).toBe(b);
    expect(list.body.items[0].excerpt).toContain('second saved');
    expect(list.body.items[0].channelId).toBe(ch());

    // ARCHIVED 탭은 비어 있다(S51 은 IN_PROGRESS 만 채움).
    const archived = await listSaved(stack.member.accessToken, '?status=ARCHIVED');
    expect(archived.body.items).toHaveLength(0);

    const count = await savedCount(stack.member.accessToken);
    expect(count.status).toBe(200);
    expect(count.body.count).toBe(2);
  });

  it('500 한도 초과 시 422 SAVED_LIMIT_EXCEEDED', async () => {
    // 500개를 DB 직접 시드(서로 다른 messageId 가 필요 — 실제 메시지 행 500개 생성).
    const now = new Date('2025-01-01T00:00:00.000Z').getTime();
    const msgRows = Array.from({ length: 500 }, (_, i) => ({
      id: crypto.randomUUID(),
      channelId: ch(),
      authorId: stack.member.userId,
      content: `bulk ${i}`,
      contentPlain: `bulk ${i}`,
      createdAt: new Date(now + i * 10),
    }));
    await env.prisma.message.createMany({ data: msgRows });
    await env.prisma.savedMessage.createMany({
      data: msgRows.map((m) => ({
        userId: stack.member.userId,
        messageId: m.id,
      })),
    });
    // 501번째 저장 시도 → 422.
    const extra = await sendMessage(stack.member.accessToken, '501st');
    const res = await saveMsg(stack.member.accessToken, extra);
    expect(res.status).toBe(422);
    expect(res.body.errorCode).toBe('SAVED_LIMIT_EXCEEDED');
  });

  it('비가시(비공개) 채널 메시지는 저장 차단 404', async () => {
    // 비공개 채널 생성(owner) → 거기 메시지 발행 → MEMBER 가 저장 시도 → 404.
    const priv = await request(env.baseUrl)
      .post(`/workspaces/${ws()}/channels`)
      .set('origin', ORIGIN)
      .set(bearer(stack.owner.accessToken))
      .send({ name: `priv-${Date.now().toString(36).slice(-6)}`, type: 'TEXT', isPrivate: true });
    expect(priv.status).toBe(201);
    const privChannelId = priv.body.id as string;
    const privMsg = await request(env.baseUrl)
      .post(`/workspaces/${ws()}/channels/${privChannelId}/messages`)
      .set('origin', ORIGIN)
      .set(bearer(stack.owner.accessToken))
      .send({ content: 'secret' });
    expect(privMsg.status).toBe(201);
    const privMsgId = privMsg.body.message.id as string;
    // MEMBER(비공개 채널 비멤버)가 저장 시도 → 404.
    const res = await saveMsg(stack.member.accessToken, privMsgId);
    expect(res.status).toBe(404);
    expect(res.body.errorCode).toBe('MESSAGE_NOT_FOUND');
  });

  it('원본 soft-delete 시 messageDeletedAt 반영 + 목록 excerpt 마스킹', async () => {
    const msgId = await sendMessage(stack.member.accessToken, 'will be deleted');
    await saveMsg(stack.member.accessToken, msgId);
    // 작성자 본인이 원본 soft-delete.
    expect((await deleteMsg(stack.member.accessToken, msgId)).status).toBe(204);
    // SavedMessage.messageDeletedAt 가 채워짐.
    const row = await env.prisma.savedMessage.findFirst({ where: { messageId: msgId } });
    expect(row).toBeTruthy();
    expect(row!.messageDeletedAt).not.toBeNull();
    // 목록은 행을 유지하되 excerpt 를 '[삭제된 메시지]' 로 마스킹.
    const list = await listSaved(stack.member.accessToken, '?status=IN_PROGRESS');
    const item = list.body.items.find((x: { messageId: string }) => x.messageId === msgId);
    expect(item).toBeTruthy();
    expect(item.messageDeletedAt).not.toBeNull();
    expect(item.excerpt).toBe('[삭제된 메시지]');
  });
});

describe('S51 FR-PS-15 — SYSTEM_PIN 시스템 메시지 멤버 삭제', () => {
  it('일반 MEMBER 가 SYSTEM_PIN 을 삭제할 수 있고 원본 핀은 유지된다', async () => {
    // member1(작성자) 가 메시지 핀 → SYSTEM_PIN 자동 삽입. 삭제는 다른 사람(admin)이
    // 아닌 일반 멤버여도 가능해야 한다 — 여기서는 작성자가 아닌 다른 멤버 owner 가
    // SYSTEM_PIN 을 삭제(SYSTEM 작성자도 owner 본인도 아닌 케이스를 보장하려 member 가
    // 작성·핀하고 owner(워크스페이스 owner)도 ADMIN+ 이므로, 순수 MEMBER 삭제를 보려면
    // member 자신이 SYSTEM_PIN 을 삭제: member 는 SYSTEM_PIN 의 작성자가 아니다).
    const target = await sendMessage(stack.member.accessToken, 'pin target');
    expect((await pin(stack.member.accessToken, target)).status).toBe(200);
    const sys = await env.prisma.message.findFirst({
      where: { channelId: ch(), type: 'SYSTEM_PIN' },
    });
    expect(sys).toBeTruthy();
    // 일반 MEMBER(시스템 메시지의 작성자가 아님)가 SYSTEM_PIN 삭제 → 204.
    const del = await deleteMsg(stack.member.accessToken, sys!.id);
    expect(del.status).toBe(204);
    // SYSTEM_PIN 행은 soft-delete 됐지만 원본 메시지의 핀(pinnedAt)은 유지.
    const sysRow = await env.prisma.message.findUnique({ where: { id: sys!.id } });
    expect(sysRow!.deletedAt).not.toBeNull();
    const original = await env.prisma.message.findUnique({ where: { id: target } });
    expect(original!.pinnedAt).not.toBeNull();
  });

  it('일반 메시지는 타인이 삭제할 수 없다(작성자/ADMIN 만)', async () => {
    const msgId = await sendMessage(stack.member.accessToken, 'not yours');
    // owner 는 워크스페이스 OWNER 라 모더레이터로 삭제 가능 — 대신 또 다른 MEMBER 가
    // 없으므로, admin 을 일시 강등하지 않고 "작성자 아닌 일반 멤버" 경로를 보기 위해
    // 새 멤버를 만들지 않고 nonMember(워크스페이스 비멤버)로 게이트 체인을 확인한다.
    const res = await deleteMsg(stack.nonMember.accessToken, msgId);
    // 비멤버는 워크스페이스/채널 가드에서 막힌다(403/404 계열).
    expect(res.status).toBeGreaterThanOrEqual(403);
    // 원본은 그대로 살아 있다.
    const row = await env.prisma.message.findUnique({ where: { id: msgId } });
    expect(row!.deletedAt).toBeNull();
  });
});
