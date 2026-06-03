/**
 * S64 (D12 / FR-RM09·11·12) 모더레이션 마무리 통합 테스트:
 *  - FR-RM09 Bulk Purge: MANAGE_MESSAGES 권한자 일괄 soft-delete(messageIds / latest N) +
 *    200 상한(BULK_DELETE_LIMIT) + 단일 BULK_MESSAGE_DELETE AuditLog(details.messageIds[]).
 *  - FR-RM11 신고 큐: 멤버 신고(중복 방지 409) + ADMIN/MOD 큐 열람·처리(DISMISS/DELETE_MESSAGE)
 *    + resolved* 기록 + REPORT_RESOLVE 감사.
 *  - FR-RM12 감사 조회: VIEW_AUDIT_LOG(ADMIN+) 게이트 + cursor 페이지네이션 + action/actor 필터.
 *  - 신규 감사 기록 지점: ROLE_CREATE/UPDATE/DELETE · MEMBER_ROLE_UPDATE ·
 *    CHANNEL_PERMISSION_OVERRIDE_SET · MESSAGE_DELETE · SLOWMODE_UPDATE.
 *
 * 단일 파일 실행(OOM 회피): pnpm --filter @qufox/api test -- s64-moderation-finish
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

async function setRole(
  workspaceId: string,
  ownerAccessToken: string,
  userId: string,
  role: 'ADMIN' | 'MODERATOR' | 'MEMBER' | 'GUEST',
): Promise<void> {
  await request(env.baseUrl)
    .patch(`/workspaces/${workspaceId}/members/${userId}/role`)
    .set('Authorization', `Bearer ${ownerAccessToken}`)
    .send({ role })
    .expect(200);
}

function auditCount(workspaceId: string, action: string): Promise<number> {
  return env.prisma.auditLog.count({ where: { workspaceId, action } });
}

// ── FR-RM09 Bulk Purge ───────────────────────────────────────────────────────

describe('S64 FR-RM09: bulk purge', () => {
  it('OWNER bulk-deletes messageIds → single AuditLog with messageIds[] + soft-delete', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s64bp');
    const channelId = await createChannel(workspaceId, owner.accessToken, 's64bp');
    const ids = [
      await sendMessage(workspaceId, channelId, owner.accessToken, 'm1'),
      await sendMessage(workspaceId, channelId, owner.accessToken, 'm2'),
      await sendMessage(workspaceId, channelId, owner.accessToken, 'm3'),
    ];

    const res = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${channelId}/messages/bulk-delete`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ messageIds: ids })
      .expect(200);
    expect(res.body.deletedCount).toBe(3);
    expect(new Set(res.body.messageIds)).toEqual(new Set(ids));

    // 모두 soft-delete 됨.
    const remaining = await env.prisma.message.count({
      where: { id: { in: ids }, deletedAt: null },
    });
    expect(remaining).toBe(0);

    // 단일 BULK_MESSAGE_DELETE 감사 1행 + details.messageIds[].
    const bulk = await env.prisma.auditLog.findMany({
      where: { workspaceId, action: 'BULK_MESSAGE_DELETE' },
    });
    expect(bulk.length).toBe(1);
    const details = bulk[0].details as { messageIds: string[]; deletedCount: number };
    expect(new Set(details.messageIds)).toEqual(new Set(ids));
    expect(details.deletedCount).toBe(3);
    // 개별 MESSAGE_DELETE 감사는 남지 않는다(bulk 전용 경로).
    expect(await auditCount(workspaceId, 'MESSAGE_DELETE')).toBe(0);
  });

  it('latest N mode soft-deletes the most recent N messages', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s64bpl');
    const channelId = await createChannel(workspaceId, owner.accessToken, 's64bpl');
    await sendMessage(workspaceId, channelId, owner.accessToken, 'old');
    const recent = await sendMessage(workspaceId, channelId, owner.accessToken, 'recent');

    const res = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${channelId}/messages/bulk-delete`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ latest: 1 })
      .expect(200);
    expect(res.body.deletedCount).toBe(1);
    expect(res.body.messageIds).toEqual([recent]);
  });

  it('rejects > 200 with BULK_DELETE_LIMIT (400)', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s64bpmax');
    const channelId = await createChannel(workspaceId, owner.accessToken, 's64bpmax');
    const res = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${channelId}/messages/bulk-delete`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ latest: 201 })
      .expect(400);
    // zod superRefine/max — VALIDATION_FAILED or BULK_DELETE_LIMIT, both 400.
    expect(['VALIDATION_FAILED', 'BULK_DELETE_LIMIT']).toContain(res.body.errorCode);
  });

  it('non-manager member is forbidden (403)', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s64bpf');
    const channelId = await createChannel(workspaceId, owner.accessToken, 's64bpf');
    const member = await inviteAndJoin(workspaceId, owner.accessToken, 's64bpfm');
    const mid = await sendMessage(workspaceId, channelId, owner.accessToken, 'x');
    await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${channelId}/messages/bulk-delete`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({ messageIds: [mid] })
      .expect(403);
  });
});

// ── FR-RM11 신고 큐 ────────────────────────────────────────────────────────────

describe('S64 FR-RM11: report queue', () => {
  it('member reports a message; duplicate is rejected (409)', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s64rep');
    const channelId = await createChannel(workspaceId, owner.accessToken, 's64rep');
    const member = await inviteAndJoin(workspaceId, owner.accessToken, 's64repm');
    const mid = await sendMessage(workspaceId, channelId, owner.accessToken, 'spammy');

    await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${channelId}/messages/${mid}/report`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({ category: 'SPAM', reason: '광고' })
      .expect(204);
    // 중복 신고 → 409 REPORT_DUPLICATE.
    const dup = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${channelId}/messages/${mid}/report`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({ category: 'SPAM' })
      .expect(409);
    expect(dup.body.errorCode).toBe('REPORT_DUPLICATE');
  });

  it('non-moderator cannot view the queue (403); MODERATOR can; resolve DELETE_MESSAGE', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s64q');
    const channelId = await createChannel(workspaceId, owner.accessToken, 's64q');
    const reporter = await inviteAndJoin(workspaceId, owner.accessToken, 's64qr');
    const mod = await inviteAndJoin(workspaceId, owner.accessToken, 's64qmod');
    await setRole(workspaceId, owner.accessToken, mod.userId, 'MODERATOR');
    // S64 fix-forward (security A-1): 신고 대상 메시지는 MODERATOR 보다 하위 역할(MEMBER)이
    // 작성해야 DELETE_MESSAGE 가 position 계층을 통과한다. OWNER 작성 메시지를 MODERATOR 가
    // 삭제하려 하면(이전 픽스처) A-1 가드가 403 으로 막는 게 정상이다.
    const author = await inviteAndJoin(workspaceId, owner.accessToken, 's64qauthor');
    const mid = await sendMessage(workspaceId, channelId, author.accessToken, 'bad');

    await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${channelId}/messages/${mid}/report`)
      .set('Authorization', `Bearer ${reporter.accessToken}`)
      .send({ category: 'HARASSMENT' })
      .expect(204);

    // 일반 멤버(reporter)는 큐 열람 불가.
    await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/moderation/reports`)
      .set('Authorization', `Bearer ${reporter.accessToken}`)
      .expect(403);

    // MODERATOR 큐 열람.
    const list = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/moderation/reports?filter=OPEN`)
      .set('Authorization', `Bearer ${mod.accessToken}`)
      .expect(200);
    expect(list.body.reports.length).toBe(1);
    const reportId = list.body.reports[0].id as string;
    expect(list.body.reports[0].category).toBe('HARASSMENT');

    // DELETE_MESSAGE 처리.
    await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/moderation/reports/${reportId}/resolve`)
      .set('Authorization', `Bearer ${mod.accessToken}`)
      .send({ action: 'DELETE_MESSAGE' })
      .expect(204);

    // 메시지 soft-delete 됨 + resolved 기록 + REPORT_RESOLVE 감사.
    const msg = await env.prisma.message.findUnique({ where: { id: mid } });
    expect(msg?.deletedAt).not.toBeNull();
    const rep = await env.prisma.moderationReport.findUnique({ where: { id: reportId } });
    expect(rep?.resolvedAction).toBe('DELETE_MESSAGE');
    expect(rep?.resolvedBy).toBe(mod.userId);
    expect(rep?.resolvedAt).not.toBeNull();
    expect(await auditCount(workspaceId, 'REPORT_RESOLVE')).toBe(1);

    // 이미 처리된 신고 재처리 → 409.
    await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/moderation/reports/${reportId}/resolve`)
      .set('Authorization', `Bearer ${mod.accessToken}`)
      .send({ action: 'DISMISS' })
      .expect(409);
  });
});

// ── S64 fix-forward: 보안(A-1 DELETE 계층 · A-2 마스킹 · A-4 크로스채널 IDOR) ─────

async function reportMessageAs(
  workspaceId: string,
  channelId: string,
  messageId: string,
  accessToken: string,
  category = 'SPAM',
): Promise<void> {
  await request(env.baseUrl)
    .post(`/workspaces/${workspaceId}/channels/${channelId}/messages/${messageId}/report`)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ category })
    .expect(204);
}

async function getReportId(
  workspaceId: string,
  modAccessToken: string,
  messageId: string,
): Promise<string> {
  const list = await request(env.baseUrl)
    .get(`/workspaces/${workspaceId}/moderation/reports?filter=ALL`)
    .set('Authorization', `Bearer ${modAccessToken}`)
    .expect(200);
  const found = (list.body.reports as Array<{ id: string; messageId: string }>).find(
    (r) => r.messageId === messageId,
  );
  if (!found) throw new Error('report not found in queue');
  return found.id;
}

describe('S64 fix-forward security (A-1 / A-2 / A-4)', () => {
  it('A-1: MODERATOR cannot DELETE_MESSAGE authored by a higher-ranked ADMIN (403)', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s64a1');
    const channelId = await createChannel(workspaceId, owner.accessToken, 's64a1');
    // ADMIN(상위) 작성자 + MODERATOR(하위) 처리자 + 일반 신고자.
    const admin = await inviteAndJoin(workspaceId, owner.accessToken, 's64a1adm');
    await setRole(workspaceId, owner.accessToken, admin.userId, 'ADMIN');
    const mod = await inviteAndJoin(workspaceId, owner.accessToken, 's64a1mod');
    await setRole(workspaceId, owner.accessToken, mod.userId, 'MODERATOR');
    const reporter = await inviteAndJoin(workspaceId, owner.accessToken, 's64a1rep');

    const adminMsg = await sendMessage(workspaceId, channelId, admin.accessToken, 'admin says hi');
    await reportMessageAs(workspaceId, channelId, adminMsg, reporter.accessToken, 'HARASSMENT');
    const reportId = await getReportId(workspaceId, mod.accessToken, adminMsg);

    // MODERATOR 가 ADMIN 메시지를 DELETE_MESSAGE 처리 → position 계층 거부(403).
    await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/moderation/reports/${reportId}/resolve`)
      .set('Authorization', `Bearer ${mod.accessToken}`)
      .send({ action: 'DELETE_MESSAGE' })
      .expect(403);
    // 메시지는 살아있어야 한다(부수효과 미실행).
    const msg = await env.prisma.message.findUnique({ where: { id: adminMsg } });
    expect(msg?.deletedAt).toBeNull();
    // claim 도 미획득 — 신고는 여전히 미처리.
    const rep = await env.prisma.moderationReport.findUnique({ where: { id: reportId } });
    expect(rep?.resolvedAt).toBeNull();
  });

  it('A-1: MODERATOR may DELETE_MESSAGE authored by a lower-ranked MEMBER (204)', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s64a1ok');
    const channelId = await createChannel(workspaceId, owner.accessToken, 's64a1ok');
    const mod = await inviteAndJoin(workspaceId, owner.accessToken, 's64a1okmod');
    await setRole(workspaceId, owner.accessToken, mod.userId, 'MODERATOR');
    const member = await inviteAndJoin(workspaceId, owner.accessToken, 's64a1okmem');
    const reporter = await inviteAndJoin(workspaceId, owner.accessToken, 's64a1okrep');

    const memberMsg = await sendMessage(workspaceId, channelId, member.accessToken, 'member spam');
    await reportMessageAs(workspaceId, channelId, memberMsg, reporter.accessToken, 'SPAM');
    const reportId = await getReportId(workspaceId, mod.accessToken, memberMsg);

    await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/moderation/reports/${reportId}/resolve`)
      .set('Authorization', `Bearer ${mod.accessToken}`)
      .send({ action: 'DELETE_MESSAGE' })
      .expect(204);
    const msg = await env.prisma.message.findUnique({ where: { id: memberMsg } });
    expect(msg?.deletedAt).not.toBeNull();
    // perf B-2: 이중 MESSAGE_DELETE 감사가 없어야 한다(REPORT_RESOLVE 만, impliedAction).
    expect(await auditCount(workspaceId, 'MESSAGE_DELETE')).toBe(0);
    expect(await auditCount(workspaceId, 'REPORT_RESOLVE')).toBe(1);
    const resolveRows = await env.prisma.auditLog.findMany({
      where: { workspaceId, action: 'REPORT_RESOLVE' },
    });
    expect((resolveRows[0].details as { impliedAction?: string }).impliedAction).toBe(
      'MESSAGE_DELETE',
    );
  });

  it('A-2: a non-member MODERATOR sees masked content for a private-channel report', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s64a2');
    // 비공개 채널 — OWNER 만 멤버. MODERATOR 는 채널 비멤버.
    const ch = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: `s64a2-${Date.now().toString(36).slice(-6)}`, type: 'TEXT', isPrivate: true })
      .expect(201);
    const channelId = ch.body.id as string;
    const reporter = await inviteAndJoin(workspaceId, owner.accessToken, 's64a2rep');
    // 신고자에게 채널 READ override(allowMask=1=READ) 부여 → 비공개 채널 접근·신고 가능.
    await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${channelId}/members`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ userId: reporter.userId, allowMask: 1, denyMask: 0 })
      .expect(201);
    const mod = await inviteAndJoin(workspaceId, owner.accessToken, 's64a2mod');
    await setRole(workspaceId, owner.accessToken, mod.userId, 'MODERATOR');

    const secretMsg = await sendMessage(workspaceId, channelId, owner.accessToken, 'top secret');
    await reportMessageAs(workspaceId, channelId, secretMsg, reporter.accessToken, 'OTHER');

    // 비멤버 MODERATOR 큐 열람 → content 마스킹(contentMasked=true · content=null).
    const list = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/moderation/reports?filter=ALL`)
      .set('Authorization', `Bearer ${mod.accessToken}`)
      .expect(200);
    const row = (
      list.body.reports as Array<{
        messageId: string;
        message: { content: string | null; contentMasked: boolean } | null;
      }>
    ).find((r) => r.messageId === secretMsg);
    expect(row?.message?.contentMasked).toBe(true);
    expect(row?.message?.content).toBeNull();

    // OWNER(채널 멤버) 큐 열람 → content 노출(마스킹 없음).
    const ownerList = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/moderation/reports?filter=ALL`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    const ownerRow = (
      ownerList.body.reports as Array<{
        messageId: string;
        message: { content: string | null; contentMasked: boolean } | null;
      }>
    ).find((r) => r.messageId === secretMsg);
    expect(ownerRow?.message?.contentMasked).toBe(false);
    expect(ownerRow?.message?.content).toBe('top secret');
  });

  it('A-4: bulk-delete with a cross-channel messageId leaks nothing (0 deleted in foreign channel)', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s64a4');
    const channelA = await createChannel(workspaceId, owner.accessToken, 's64a4a');
    const channelB = await createChannel(workspaceId, owner.accessToken, 's64a4b');
    const inA = await sendMessage(workspaceId, channelA, owner.accessToken, 'in A');
    const inB = await sendMessage(workspaceId, channelB, owner.accessToken, 'in B');

    // 채널 A 권한자가 채널 B 의 messageId 를 섞어 A 의 bulk-delete 로 전송.
    const res = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${channelA}/messages/bulk-delete`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ messageIds: [inA, inB] })
      .expect(200);
    // 채널 A 의 inA 만 삭제, 채널 B 의 inB 는 영향 없음(channelId 격리).
    expect(res.body.messageIds).toEqual([inA]);
    expect(res.body.deletedCount).toBe(1);
    const bStill = await env.prisma.message.findUnique({ where: { id: inB } });
    expect(bStill?.deletedAt).toBeNull();
  });
});

// ── FR-RM12 감사 조회 + 신규 기록 지점 ─────────────────────────────────────────

describe('S64 FR-RM12: audit log query', () => {
  it('non-admin is forbidden (403); ADMIN+ can list with cursor + filters', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s64al');
    const channelId = await createChannel(workspaceId, owner.accessToken, 's64al');
    const member = await inviteAndJoin(workspaceId, owner.accessToken, 's64alm');

    // 신규 기록 지점들을 트리거: MEMBER_ROLE_UPDATE.
    await setRole(workspaceId, owner.accessToken, member.userId, 'MODERATOR');
    // SLOWMODE_UPDATE.
    await request(env.baseUrl)
      .patch(`/workspaces/${workspaceId}/channels/${channelId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ slowmodeSeconds: 10 })
      .expect(200);
    // MESSAGE_DELETE(개별).
    const mid = await sendMessage(workspaceId, channelId, owner.accessToken, 'to-delete');
    await request(env.baseUrl)
      .delete(`/workspaces/${workspaceId}/channels/${channelId}/messages/${mid}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(204);
    // ROLE_CREATE.
    await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/roles`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'helper' })
      .expect(201);

    // 비-ADMIN(MODERATOR member)은 감사 조회 불가.
    await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/audit-logs`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .expect(403);

    // OWNER 조회 — 위 액션들이 모두 기록돼 있어야 한다.
    const all = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/audit-logs?limit=100`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    const actions = all.body.entries.map((e: { action: string }) => e.action);
    expect(actions).toContain('MEMBER_ROLE_UPDATE');
    expect(actions).toContain('SLOWMODE_UPDATE');
    expect(actions).toContain('MESSAGE_DELETE');
    expect(actions).toContain('ROLE_CREATE');

    // action 필터.
    const filtered = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/audit-logs?action=ROLE_CREATE`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(filtered.body.entries.length).toBeGreaterThanOrEqual(1);
    expect(filtered.body.entries.every((e: { action: string }) => e.action === 'ROLE_CREATE')).toBe(
      true,
    );

    // actor 필터(owner).
    const byActor = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/audit-logs?actorId=${owner.userId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(byActor.body.entries.every((e: { actorId: string }) => e.actorId === owner.userId)).toBe(
      true,
    );

    // cursor 페이지네이션 — limit=2 로 첫 페이지 후 nextCursor 로 다음 페이지.
    const page1 = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/audit-logs?limit=2`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(page1.body.entries.length).toBe(2);
    expect(page1.body.nextCursor).toBeTruthy();
    const page2 = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/audit-logs?limit=2&cursor=${page1.body.nextCursor}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    // 페이지 간 중복 없음(키셋).
    const ids1 = new Set(page1.body.entries.map((e: { id: string }) => e.id));
    const overlap = page2.body.entries.filter((e: { id: string }) => ids1.has(e.id));
    expect(overlap.length).toBe(0);
  });

  it('CHANNEL_PERMISSION_OVERRIDE_SET is recorded when an admin sets a channel override', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s64ov');
    const channelId = await createChannel(workspaceId, owner.accessToken, 's64ov');
    const member = await inviteAndJoin(workspaceId, owner.accessToken, 's64ovm');
    await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${channelId}/members`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ userId: member.userId, allowMask: 1, denyMask: 0 })
      .expect(201);
    expect(await auditCount(workspaceId, 'CHANNEL_PERMISSION_OVERRIDE_SET')).toBeGreaterThanOrEqual(
      1,
    );
  });

  it('rejects an invalid audit cursor with 400', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s64cur');
    await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/audit-logs?cursor=not-a-valid-cursor!!!`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(400);
  });
});
