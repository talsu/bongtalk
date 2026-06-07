/**
 * S84a (D16 / FR-RC11) integration — 인커밍 웹훅 / 봇 메시지:
 *  - 생성 응답에 평문 토큰 1회 + DB 엔 sha256 hex 만(평문/bcrypt 부재).
 *  - 인커밍 토큰 게시 → authorType=BOT 메시지 생성 + 표시 override + lastUsedAt 갱신.
 *  - 잘못된 토큰 → 403 INVALID_TOKEN, 폐기/회전된 토큰 → 403, 예약어 → 422.
 *  - 관리 엔드포인트는 비-ADMIN 멤버 403.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { WsIntEnv, setupWsIntEnv, signupAsUser } from './helpers';

let env: WsIntEnv;
const ORIGIN = 'http://localhost:45173';

beforeAll(async () => {
  env = await setupWsIntEnv();
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

async function setupOwnerWsChannel(prefix: string) {
  const owner = await signupAsUser(env.baseUrl, prefix);
  const ws = await request(env.baseUrl)
    .post('/workspaces')
    .set('origin', ORIGIN)
    .set('Authorization', `Bearer ${owner.accessToken}`)
    .send({ name: prefix, slug: `${prefix}-${Date.now().toString(36)}`.slice(0, 30) })
    .expect(201);
  const workspaceId = ws.body.id as string;
  const ch = await request(env.baseUrl)
    .post(`/workspaces/${workspaceId}/channels`)
    .set('origin', ORIGIN)
    .set('Authorization', `Bearer ${owner.accessToken}`)
    .send({ name: `wh-ch-${Date.now().toString(36).slice(-6)}`, type: 'TEXT' })
    .expect(201);
  return { owner, workspaceId, channelId: ch.body.id as string };
}

async function inviteAndJoin(workspaceId: string, ownerToken: string, prefix: string) {
  const joiner = await signupAsUser(env.baseUrl, prefix);
  const invite = await request(env.baseUrl)
    .post(`/workspaces/${workspaceId}/invites`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({})
    .expect(201);
  await request(env.baseUrl)
    .post(`/invites/${invite.body.invite.code}/accept`)
    .set('Authorization', `Bearer ${joiner.accessToken}`)
    .expect(201);
  return joiner;
}

describe('S84a webhook management', () => {
  it('creates a webhook returning a plaintext token once, storing only sha256 hex', async () => {
    const { owner, workspaceId, channelId } = await setupOwnerWsChannel('s84acreate');
    const res = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/webhooks`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ channelId, name: 'Deploy Bot' })
      .expect(201);
    expect(res.body.token).toMatch(/^whk_/);
    expect(res.body.postUrl).toContain(`/webhooks/${res.body.id}`);

    const row = await env.prisma.incomingWebhook.findUnique({ where: { id: res.body.id } });
    expect(row).not.toBeNull();
    // 평문/ bcrypt 부재: 저장된 tokenHash 는 sha256 의 64-hex 이며 평문과 다르다.
    expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.tokenHash).not.toBe(res.body.token);
  });

  it('rejects reserved names with 422', async () => {
    const { owner, workspaceId, channelId } = await setupOwnerWsChannel('s84aresv');
    const res = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/webhooks`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ channelId, name: 'System' })
      .expect(422);
    expect(res.body.errorCode ?? res.body.code).toBe('WEBHOOK_NAME_RESERVED');
  });

  it('list never exposes token or hash', async () => {
    const { owner, workspaceId, channelId } = await setupOwnerWsChannel('s84alist');
    await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/webhooks`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ channelId, name: 'Notifier' })
      .expect(201);
    const res = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/webhooks`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(res.body.items.length).toBe(1);
    expect(res.body.items[0].token).toBeUndefined();
    expect(res.body.items[0].tokenHash).toBeUndefined();
  });

  it('forbids non-ADMIN members from managing webhooks (403, incl. list)', async () => {
    const { owner, workspaceId } = await setupOwnerWsChannel('s84aperm');
    const member = await inviteAndJoin(workspaceId, owner.accessToken, 's84amember');
    // NIT-8: 목록도 ADMIN 게이트 — 일반 멤버는 403.
    await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/webhooks`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .expect(403);
    const res = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/webhooks`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({ channelId: workspaceId, name: 'Sneaky' })
      .expect(403);
    expect(res.status).toBe(403);
  });

  it('rejects creating a webhook for a channel in another workspace (CHANNEL_NOT_FOUND)', async () => {
    const a = await setupOwnerWsChannel('s84axwsa');
    const b = await setupOwnerWsChannel('s84axwsb');
    // a 의 OWNER 가 b 의 채널을 대상으로 자기 워크스페이스 웹훅을 만들려 시도 → 차단.
    const res = await request(env.baseUrl)
      .post(`/workspaces/${a.workspaceId}/webhooks`)
      .set('Authorization', `Bearer ${a.owner.accessToken}`)
      .send({ channelId: b.channelId, name: 'Cross WS' })
      .expect(404);
    expect(res.body.errorCode ?? res.body.code).toBe('CHANNEL_NOT_FOUND');
  });
});

describe('S84a incoming webhook post', () => {
  async function createWebhook(prefix: string, body: Record<string, unknown> = {}) {
    const ctx = await setupOwnerWsChannel(prefix);
    const res = await request(env.baseUrl)
      .post(`/workspaces/${ctx.workspaceId}/webhooks`)
      .set('Authorization', `Bearer ${ctx.owner.accessToken}`)
      .send({ channelId: ctx.channelId, name: 'CI Bot', ...body })
      .expect(201);
    return { ...ctx, webhookId: res.body.id as string, token: res.body.token as string };
  }

  it('posts a BOT message with a valid token (Bearer) and bumps lastUsedAt', async () => {
    const wh = await createWebhook('s84apost');
    const res = await request(env.baseUrl)
      .post(`/webhooks/${wh.webhookId}`)
      .set('Authorization', `Bearer ${wh.token}`)
      .send({ content: 'build **passed** :rocket:', username: 'Builder' })
      .expect(201);

    const msg = await env.prisma.message.findUnique({ where: { id: res.body.messageId } });
    expect(msg).not.toBeNull();
    expect(msg!.authorType).toBe('BOT');
    expect(msg!.webhookId).toBe(wh.webhookId);
    // 요청 username override 가 표시 이름으로 해석돼 저장된다.
    expect(msg!.botUsername).toBe('Builder');
    expect(msg!.channelId).toBe(wh.channelId);

    const row = await env.prisma.incomingWebhook.findUnique({ where: { id: wh.webhookId } });
    expect(row!.lastUsedAt).not.toBeNull();
  });

  it('falls back to webhook name when no username override is given', async () => {
    const wh = await createWebhook('s84afallback');
    const res = await request(env.baseUrl)
      .post(`/webhooks/${wh.webhookId}?token=${encodeURIComponent(wh.token)}`)
      .send({ content: 'hello from query token' })
      .expect(201);
    const msg = await env.prisma.message.findUnique({ where: { id: res.body.messageId } });
    expect(msg!.botUsername).toBe('CI Bot');
  });

  it('rejects an invalid token with 403 INVALID_TOKEN', async () => {
    const wh = await createWebhook('s84abad');
    const res = await request(env.baseUrl)
      .post(`/webhooks/${wh.webhookId}`)
      .set('Authorization', `Bearer whk_totally-wrong-token`)
      .send({ content: 'nope' })
      .expect(403);
    expect(res.body.errorCode ?? res.body.code).toBe('WEBHOOK_INVALID_TOKEN');
  });

  it('rejects reserved username with 422', async () => {
    const wh = await createWebhook('s84aresvuser');
    const res = await request(env.baseUrl)
      .post(`/webhooks/${wh.webhookId}`)
      .set('Authorization', `Bearer ${wh.token}`)
      .send({ content: 'x', username: 'ADMIN' })
      .expect(422);
    expect(res.body.errorCode ?? res.body.code).toBe('WEBHOOK_NAME_RESERVED');
  });

  it('returns 403 REVOKED after the webhook is revoked', async () => {
    const wh = await createWebhook('s84arevoke');
    await request(env.baseUrl)
      .delete(`/workspaces/${wh.workspaceId}/webhooks/${wh.webhookId}`)
      .set('Authorization', `Bearer ${wh.owner.accessToken}`)
      .expect(204);
    const res = await request(env.baseUrl)
      .post(`/webhooks/${wh.webhookId}`)
      .set('Authorization', `Bearer ${wh.token}`)
      .send({ content: 'after revoke' })
      .expect(403);
    expect(res.body.errorCode ?? res.body.code).toBe('WEBHOOK_REVOKED');
  });

  it('does not leak REVOKED for a wrong token on a revoked webhook (no existence oracle)', async () => {
    const wh = await createWebhook('s84aoracle');
    await request(env.baseUrl)
      .delete(`/workspaces/${wh.workspaceId}/webhooks/${wh.webhookId}`)
      .set('Authorization', `Bearer ${wh.owner.accessToken}`)
      .expect(204);
    // 폐기된 웹훅 + 잘못된 토큰 → REVOKED 가 아니라 INVALID_TOKEN(라이프사이클 비노출).
    const res = await request(env.baseUrl)
      .post(`/webhooks/${wh.webhookId}`)
      .set('Authorization', `Bearer whk_wrong-token-on-revoked`)
      .send({ content: 'probe' })
      .expect(403);
    expect(res.body.errorCode ?? res.body.code).toBe('WEBHOOK_INVALID_TOKEN');
  });

  it('invalidates the old token and accepts the new one after rotate', async () => {
    const wh = await createWebhook('s84arotate');
    const rot = await request(env.baseUrl)
      .post(`/workspaces/${wh.workspaceId}/webhooks/${wh.webhookId}/rotate`)
      .set('Authorization', `Bearer ${wh.owner.accessToken}`)
      .expect(201);
    const newToken = rot.body.token as string;
    expect(newToken).not.toBe(wh.token);

    // 기존 토큰은 무효(403).
    await request(env.baseUrl)
      .post(`/webhooks/${wh.webhookId}`)
      .set('Authorization', `Bearer ${wh.token}`)
      .send({ content: 'old token' })
      .expect(403);
    // 새 토큰은 정상 게시(201).
    await request(env.baseUrl)
      .post(`/webhooks/${wh.webhookId}`)
      .set('Authorization', `Bearer ${newToken}`)
      .send({ content: 'new token' })
      .expect(201);
  });
});
