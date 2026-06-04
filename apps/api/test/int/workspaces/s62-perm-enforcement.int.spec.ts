/**
 * S62 fix-forward (D12 권한 집행 배선) integration:
 *  - A-1 (security MAJOR-1 / MEDIUM-2): 시스템 역할 enum 변경(updateRole)·소유권
 *    이양(transferOwnership) 직후 `perms:{channelId}:{userId}` 권한 캐시가 즉시
 *    DEL 되어 강등/승격 후 stale 권한이 남지 않는다.
 *  - A-2 (security HIGH-1 / FR-RM17): ADMINISTRATOR 보유자가 채널 DENY overwrite 를
 *    우회해 히스토리를 열람하면 AuditLog(action='ADMINISTRATOR_CHANNEL_BYPASS',
 *    details.performedAction='HISTORY_VIEW') 가 기록되고, raw denyMask 비트맵은
 *    노출되지 않는다(A-4 = MEDIUM-5: details.denyExisted 만).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { WsIntEnv, setupWsIntEnv, signupAsUser, STRONG_PW } from './helpers';

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

async function setupOwnerAndWs(prefix: string): Promise<{
  owner: Awaited<ReturnType<typeof signupAsUser>>;
  workspaceId: string;
}> {
  const owner = await signupAsUser(env.baseUrl, prefix);
  const create = await request(env.baseUrl)
    .post('/workspaces')
    .set('origin', ORIGIN)
    .set('Authorization', `Bearer ${owner.accessToken}`)
    .send({ name: prefix, slug: `${prefix}-${Date.now().toString(36)}`.slice(0, 30) })
    .expect(201);
  return { owner, workspaceId: create.body.id as string };
}

async function inviteAndJoin(
  workspaceId: string,
  ownerAccessToken: string,
  prefix: string,
): Promise<{ userId: string; accessToken: string }> {
  const joiner = await signupAsUser(env.baseUrl, prefix);
  const invite = await request(env.baseUrl)
    .post(`/workspaces/${workspaceId}/invites`)
    .set('Authorization', `Bearer ${ownerAccessToken}`)
    .send({})
    .expect(201);
  const code = invite.body.invite.code as string;
  await request(env.baseUrl)
    .post(`/invites/${code}/accept`)
    .set('Authorization', `Bearer ${joiner.accessToken}`)
    .expect(201);
  return { userId: joiner.userId, accessToken: joiner.accessToken };
}

async function createChannel(
  workspaceId: string,
  ownerAccessToken: string,
  prefix: string,
): Promise<string> {
  const ch = await request(env.baseUrl)
    .post(`/workspaces/${workspaceId}/channels`)
    .set('Authorization', `Bearer ${ownerAccessToken}`)
    .send({ name: `${prefix}-${Date.now().toString(36).slice(-6)}`, type: 'TEXT' })
    .expect(201);
  return ch.body.id as string;
}

async function sendMessage(
  workspaceId: string,
  channelId: string,
  accessToken: string,
  content: string,
): Promise<string> {
  const res = await request(env.baseUrl)
    .post(`/workspaces/${workspaceId}/channels/${channelId}/messages`)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ content })
    .expect(201);
  return res.body.message.id as string;
}

// ── A-1: 역할 변경 시 권한 캐시 무효화 ───────────────────────────────────────

describe('S62 A-1: system-role change invalidates perms cache', () => {
  it('DELs perms:{channelId}:{userId} after updateRole (demotion)', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s62a1');
    const member = await inviteAndJoin(workspaceId, owner.accessToken, 's62a1m');
    const channelId = await createChannel(workspaceId, owner.accessToken, 's62a1ch');
    const cacheKey = `perms:${channelId}:${member.userId}`;

    // 멤버 승격(MEMBER→ADMIN) 후 send 로 권한 캐시를 워밍한다(resolveEffective →
    // cacheSet). hasMentionEveryone/slowmode 경로는 무관하므로 일반 send 로 충분치
    // 않을 수 있어, BYPASS_SLOWMODE 게이트를 타도록 슬로우모드 채널이 아니어도
    // resolveEffective 가 호출되는 announcement/override 경로 대신, 직접 캐시를
    // 워밍하기 위해 권한 의존 엔드포인트(첨부 upload-url 의 requireUpload)를 호출한다.
    await request(env.baseUrl)
      .patch(`/workspaces/${workspaceId}/members/${member.userId}/role`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ role: 'ADMIN' })
      .expect(200);

    // resolveEffective 를 확실히 태워 캐시를 워밍: 슬로우모드 1초 채널을 만들고 send
    // → hasPermission(BYPASS_SLOWMODE) 가 resolveEffective → cacheSet 을 수행한다.
    const slowCh = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: `s62a1slow-${Date.now().toString(36).slice(-6)}`, type: 'TEXT' })
      .expect(201);
    const slowChId = slowCh.body.id as string;
    await request(env.baseUrl)
      .patch(`/workspaces/${workspaceId}/channels/${slowChId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ slowmodeSeconds: 5 })
      .expect(200);
    const slowCacheKey = `perms:${slowChId}:${member.userId}`;
    await sendMessage(workspaceId, slowChId, member.accessToken, 'warm cache');

    // 캐시가 워밍됐는지 확인(best-effort — Redis 가 있으니 set 됐어야 한다).
    expect(await env.redis.get(slowCacheKey)).not.toBeNull();

    // 강등(ADMIN→MEMBER). updateRole 트랜잭션 직후 invalidateMemberPermsCache 가
    // 그 멤버의 모든 채널 권한 캐시를 DEL 해야 한다.
    await request(env.baseUrl)
      .patch(`/workspaces/${workspaceId}/members/${member.userId}/role`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ role: 'MEMBER' })
      .expect(200);

    // A-1 핵심: 강등 직후 해당 멤버의 채널 권한 캐시 키가 모두 사라진다.
    expect(await env.redis.get(slowCacheKey)).toBeNull();
    expect(await env.redis.get(cacheKey)).toBeNull();
  });

  it('DELs both members perms cache after transferOwnership', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s62a1t');
    const heir = await inviteAndJoin(workspaceId, owner.accessToken, 's62a1th');
    const channelId = await createChannel(workspaceId, owner.accessToken, 's62a1tch');

    // 슬로우모드로 두 멤버 캐시를 워밍한다.
    await request(env.baseUrl)
      .patch(`/workspaces/${workspaceId}/channels/${channelId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ slowmodeSeconds: 5 })
      .expect(200);
    await sendMessage(workspaceId, channelId, owner.accessToken, 'owner warm');
    await sendMessage(workspaceId, channelId, heir.accessToken, 'heir warm');
    const ownerKey = `perms:${channelId}:${owner.userId}`;
    const heirKey = `perms:${channelId}:${heir.userId}`;
    expect(await env.redis.get(ownerKey)).not.toBeNull();
    expect(await env.redis.get(heirKey)).not.toBeNull();

    await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/transfer-ownership`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      // S65 (FR-W13): 양도는 OWNER 비밀번호 재확인을 강제한다.
      .send({ toUserId: heir.userId, password: STRONG_PW })
      .expect(200);

    // A-1 핵심: from(ex-OWNER) + to(new OWNER) 두 멤버 모두 캐시가 무효화된다.
    expect(await env.redis.get(ownerKey)).toBeNull();
    expect(await env.redis.get(heirKey)).toBeNull();
  });
});

// ── A-2 / A-4: ADMINISTRATOR 우회 감사(히스토리 열람) ─────────────────────────

describe('S62 A-2/A-4: ADMINISTRATOR bypass audit on history view', () => {
  it('records ADMINISTRATOR_CHANNEL_BYPASS with HISTORY_VIEW and no raw mask', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s62a2');
    const channelId = await createChannel(workspaceId, owner.accessToken, 's62a2ch');

    // OWNER 자신(ADMINISTRATOR)의 시스템 역할 리터럴 'OWNER' 에 DENY overwrite 를
    // 건다(WRITE_MESSAGE 거부). enforcement 는 ADMINISTRATOR 단락으로 통과하지만,
    // 우회 감사 판정 조건(액터 principal 대상 DENY 존재 + ADMINISTRATOR 보유)이 성립한다.
    await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${channelId}/roles`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ role: 'OWNER', allowMask: 0, denyMask: 4 })
      .expect(201);

    // OWNER 가 메시지를 보낸 뒤 한 번 편집해 편집 이력을 만든다(신규 메시지 version=0).
    const msgId = await sendMessage(workspaceId, channelId, owner.accessToken, 'original');
    await request(env.baseUrl)
      .patch(`/workspaces/${workspaceId}/channels/${channelId}/messages/${msgId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ content: 'edited once', expectedVersion: 0 })
      .expect(200);

    // 히스토리 열람 — 우회 감사가 기록되어야 한다.
    await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/channels/${channelId}/messages/${msgId}/history`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    const logs = await env.prisma.auditLog.findMany({
      where: { workspaceId, channelId, action: 'ADMINISTRATOR_CHANNEL_BYPASS' },
    });
    const historyLog = logs.find(
      (l) => (l.details as { performedAction?: string } | null)?.performedAction === 'HISTORY_VIEW',
    );
    expect(historyLog).toBeTruthy();
    const details = historyLog?.details as Record<string, unknown> | null;
    // A-4: raw denyMask 비트맵이 details 에 노출되지 않는다(denyExisted boolean 만).
    expect(details).not.toHaveProperty('deniedMask');
    expect(details?.denyExisted).toBe(true);
  });
});
