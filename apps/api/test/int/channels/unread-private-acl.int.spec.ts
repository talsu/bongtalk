import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { bearer, type ChIntEnv, ORIGIN, seedWorkspaceWithRoles, setupChIntEnv } from './helpers';
import { UnreadService } from '../../../src/channels/unread.service';

let env: ChIntEnv;
let unread: UnreadService;

beforeAll(async () => {
  env = await setupChIntEnv();
  unread = env.app.get(UnreadService);
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

/**
 * Task-019-A: regression guard for the 018-follow-1 private-channel
 * unread ACL leak. Before the fix, `summarize` and
 * `summarizeWorkspaceTotals` both folded private channels the caller
 * could not read into their totals — IDOR-grade information
 * disclosure ("there are N unread messages in a channel you're not in").
 *
 * Shape of the test: OWNER + MEMBER + a second member who is NOT
 * whitelisted on a private channel. Owner posts N messages in the
 * private channel. Assertions:
 *
 *   - GET /workspaces/:id/unread-summary for the excluded member:
 *     the private channelId must NOT appear in the response list.
 *   - GET /me/unread-totals for the excluded member: the workspace
 *     total must be 0 (no unread leaks via the aggregate either).
 *   - OWNER still sees the private channel's unread count (own
 *     messages are skipped, so it shows as 0 but the channel row
 *     must appear).
 *   - An EXPLICITLY WHITELISTED member (USER override with allow=READ)
 *     DOES see the private channel's unread count.
 */
describe('unread private-channel ACL (task-019-A, 018-follow-1)', () => {
  it('excludes private-channel unread for non-whitelisted members (summarize + totals)', async () => {
    const { workspaceId, owner, member, admin } = await seedWorkspaceWithRoles(env.baseUrl);

    const pubCh = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels`)
      .set('origin', ORIGIN)
      .set(bearer(owner.accessToken))
      .send({ name: 'public', type: 'TEXT' });
    expect(pubCh.status).toBe(201);

    const privCh = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels`)
      .set('origin', ORIGIN)
      .set(bearer(owner.accessToken))
      .send({ name: 'secret', type: 'TEXT', isPrivate: true });
    expect(privCh.status).toBe(201);

    // Owner posts 2 public + 3 private messages. Owner's own messages
    // don't count against the reader's unread, so we use `admin` as
    // the poster so MEMBER's unread rises.
    for (let i = 0; i < 2; i += 1) {
      await request(env.baseUrl)
        .post(`/workspaces/${workspaceId}/channels/${pubCh.body.id}/messages`)
        .set('origin', ORIGIN)
        .set(bearer(owner.accessToken))
        .send({ content: `pub-${i}` });
    }
    // admin posts to the private channel — but admin needs visibility
    // first. Owner is the only role that always sees private channels.
    // For this test we post as owner (so MEMBER would have 0 unread
    // even if they COULD see it, because authorId = viewer excluded);
    // the guard is "row must not appear", not "count = 0".
    for (let i = 0; i < 3; i += 1) {
      await request(env.baseUrl)
        .post(`/workspaces/${workspaceId}/channels/${privCh.body.id}/messages`)
        .set('origin', ORIGIN)
        .set(bearer(owner.accessToken))
        .send({ content: `priv-${i}` });
    }

    // MEMBER (non-whitelisted) view
    const sumRes = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/unread-summary`)
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken));
    expect(sumRes.status).toBe(200);
    const summarized = sumRes.body.channels as Array<{ channelId: string }>;
    expect(summarized.map((c) => c.channelId)).toContain(pubCh.body.id);
    expect(summarized.map((c) => c.channelId)).not.toContain(privCh.body.id);

    const totRes = await request(env.baseUrl)
      .get('/me/unread-totals')
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken));
    expect(totRes.status).toBe(200);
    const memberTotal = (
      totRes.body.totals as Array<{ workspaceId: string; unreadCount: number }>
    ).find((t) => t.workspaceId === workspaceId);
    expect(memberTotal).toBeDefined();
    expect(memberTotal?.unreadCount).toBe(2); // only the 2 public messages
    void admin;

    // OWNER still sees the private channel row.
    const ownerSum = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/unread-summary`)
      .set('origin', ORIGIN)
      .set(bearer(owner.accessToken));
    expect(ownerSum.body.channels.map((c: { channelId: string }) => c.channelId)).toContain(
      privCh.body.id,
    );
  });

  it('whitelisted USER override lets a MEMBER see the private channel unread', async () => {
    const { workspaceId, owner, member } = await seedWorkspaceWithRoles(env.baseUrl);

    const privCh = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels`)
      .set('origin', ORIGIN)
      .set(bearer(owner.accessToken))
      .send({ name: 'secret', type: 'TEXT', isPrivate: true });
    expect(privCh.status).toBe(201);

    // Grant the member USER-level READ allow on the private channel.
    await env.prisma.channelPermissionOverride.create({
      data: {
        channelId: privCh.body.id,
        principalType: 'USER',
        principalId: member.userId,
        allowMask: 0x0001, // Permission.READ
        denyMask: 0,
      },
    });

    await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${privCh.body.id}/messages`)
      .set('origin', ORIGIN)
      .set(bearer(owner.accessToken))
      .send({ content: 'visible to whitelisted member' });

    const sumRes = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/unread-summary`)
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken));
    expect(sumRes.status).toBe(200);
    const summarized = sumRes.body.channels as Array<{
      channelId: string;
      unreadCount: number;
    }>;
    const row = summarized.find((c) => c.channelId === privCh.body.id);
    expect(row).toBeDefined();
    expect(row?.unreadCount).toBe(1);
  });

  it('ROLE override (principalType=ROLE) lets every member of that role see the private channel', async () => {
    const { workspaceId, owner, admin } = await seedWorkspaceWithRoles(env.baseUrl);

    const privCh = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels`)
      .set('origin', ORIGIN)
      .set(bearer(owner.accessToken))
      .send({ name: 'admin-only', type: 'TEXT', isPrivate: true });
    expect(privCh.status).toBe(201);

    await env.prisma.channelPermissionOverride.create({
      data: {
        channelId: privCh.body.id,
        principalType: 'ROLE',
        principalId: 'ADMIN',
        allowMask: 0x0001,
        denyMask: 0,
      },
    });

    await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${privCh.body.id}/messages`)
      .set('origin', ORIGIN)
      .set(bearer(owner.accessToken))
      .send({ content: 'admins only' });

    const sumRes = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/unread-summary`)
      .set('origin', ORIGIN)
      .set(bearer(admin.accessToken));
    expect(sumRes.status).toBe(200);
    const summarized = sumRes.body.channels as Array<{
      channelId: string;
      unreadCount: number;
    }>;
    const row = summarized.find((c) => c.channelId === privCh.body.id);
    expect(row).toBeDefined();
    expect(row?.unreadCount).toBe(1);
  });

  it('DENY beats ALLOW (reviewer BLOCKER-1 regression): USER deny on READ hides the channel', async () => {
    const { workspaceId, owner, member } = await seedWorkspaceWithRoles(env.baseUrl);

    const privCh = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels`)
      .set('origin', ORIGIN)
      .set(bearer(owner.accessToken))
      .send({ name: 'deny-wins', type: 'TEXT', isPrivate: true });
    expect(privCh.status).toBe(201);

    // Two rows — ALLOW on READ at ROLE level, DENY on READ at USER level.
    // Effective = allow & ~deny = 0 → member must NOT see it.
    await env.prisma.channelPermissionOverride.create({
      data: {
        channelId: privCh.body.id,
        principalType: 'ROLE',
        principalId: 'MEMBER',
        allowMask: 0x0001,
        denyMask: 0,
      },
    });
    await env.prisma.channelPermissionOverride.create({
      data: {
        channelId: privCh.body.id,
        principalType: 'USER',
        principalId: member.userId,
        allowMask: 0,
        denyMask: 0x0001,
      },
    });

    await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${privCh.body.id}/messages`)
      .set('origin', ORIGIN)
      .set(bearer(owner.accessToken))
      .send({ content: 'should not leak' });

    const sumRes = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/unread-summary`)
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken));
    expect(sumRes.status).toBe(200);
    const channelIds = (sumRes.body.channels as Array<{ channelId: string }>).map(
      (c) => c.channelId,
    );
    expect(channelIds).not.toContain(privCh.body.id);

    const totRes = await request(env.baseUrl)
      .get('/me/unread-totals')
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken));
    const myTotal = (
      totRes.body.totals as Array<{ workspaceId: string; unreadCount: number }>
    ).find((t) => t.workspaceId === workspaceId);
    expect(myTotal?.unreadCount).toBe(0);
  });

  /**
   * S21 fix-forward (NIT-H): 2→5단계 fold 경계의 핵심 케이스. roleDeny(READ) 가
   * userAllow(READ) 를 가리던 종전 2단계 union 과 달리, PermissionMatrix.effective
   * 의 5단계 fold 는 "개인 ALLOW > 역할 DENY" 라 채널이 보여야 한다. summarize +
   * totals 둘 다 이 경계를 통과해야 한다(MINOR-E/CRITICAL-C 정합).
   */
  it('userAllow(READ) beats roleDeny(READ) on a private channel (2→5 stage fold boundary)', async () => {
    const { workspaceId, owner, member } = await seedWorkspaceWithRoles(env.baseUrl);

    const privCh = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels`)
      .set('origin', ORIGIN)
      .set(bearer(owner.accessToken))
      .send({ name: 'fold-boundary', type: 'TEXT', isPrivate: true });
    expect(privCh.status).toBe(201);

    // ROLE(MEMBER) DENY READ + USER(member) ALLOW READ. 2단계 union 은
    // (allow & ~deny)=0 으로 가렸으나, 5단계 fold 는 userAllow 가 roleDeny 를
    // 이기므로 가시.
    await env.prisma.channelPermissionOverride.create({
      data: {
        channelId: privCh.body.id,
        principalType: 'ROLE',
        principalId: 'MEMBER',
        allowMask: 0,
        denyMask: 0x0001,
      },
    });
    await env.prisma.channelPermissionOverride.create({
      data: {
        channelId: privCh.body.id,
        principalType: 'USER',
        principalId: member.userId,
        allowMask: 0x0001,
        denyMask: 0,
      },
    });

    await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${privCh.body.id}/messages`)
      .set('origin', ORIGIN)
      .set(bearer(owner.accessToken))
      .send({ content: 'visible because userAllow beats roleDeny' });

    // summarize (GET /unread-summary) — 채널 행이 나타나고 unread 1.
    const sumRes = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/unread-summary`)
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken));
    expect(sumRes.status).toBe(200);
    const row = (sumRes.body.channels as Array<{ channelId: string; unreadCount: number }>).find(
      (c) => c.channelId === privCh.body.id,
    );
    expect(row).toBeDefined();
    expect(row?.unreadCount).toBe(1);

    // totals — 워크스페이스 합계에도 그 1 이 반영(상관 서브쿼리 → CTE 통합 정합).
    const totRes = await request(env.baseUrl)
      .get('/me/unread-totals')
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken));
    const myTotal = (
      totRes.body.totals as Array<{ workspaceId: string; unreadCount: number }>
    ).find((t) => t.workspaceId === workspaceId);
    expect(myTotal?.unreadCount).toBe(1);
  });

  /**
   * S21 fix-forward (MINOR-E + NIT-H): OWNER 명시 READ DENY → 비가시. 종전 unread
   * SQL 의 `role='OWNER'` 무조건 가시 단락은 PermissionMatrix.effective(OWNER 도
   * 명시 DENY 존중)와 어긋났다. 단락 제거 후 OWNER baseline 도 5단계 fold 를
   * 통과하므로 USER DENY READ 가 OWNER 에게도 적용된다. summarize + totals 둘 다.
   */
  it('OWNER explicit READ DENY hides a private channel (effective parity, no OWNER short-circuit)', async () => {
    const { workspaceId, owner, admin } = await seedWorkspaceWithRoles(env.baseUrl);

    const privCh = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels`)
      .set('origin', ORIGIN)
      .set(bearer(owner.accessToken))
      .send({ name: 'owner-denied', type: 'TEXT', isPrivate: true });
    expect(privCh.status).toBe(201);

    // OWNER 본인에게 USER DENY READ. 비공개 채널 생성 시 생성자(OWNER)에게
    // allowMask=0xff 의 creator USER override 가 이미 깔리므로(channels.service),
    // 새 row 를 만들지 않고 그 row 에 denyMask=READ 를 얹는다(5단계 fold 의 마지막
    // userDeny AND-NOT 으로 READ 가 제거 → 비가시).
    await env.prisma.channelPermissionOverride.upsert({
      where: {
        channelId_principalType_principalId: {
          channelId: privCh.body.id,
          principalType: 'USER',
          principalId: owner.userId,
        },
      },
      create: {
        channelId: privCh.body.id,
        principalType: 'USER',
        principalId: owner.userId,
        allowMask: 0,
        denyMask: 0x0001,
      },
      update: {
        denyMask: 0x0001,
      },
    });

    // admin 이 메시지를 넣어야 owner 의 unread 가 생길 수 있으나, admin 도 비공개
    // 채널을 보려면 권한이 필요 → owner 가 직접 넣되(작성자=뷰어 제외) 채널 자체가
    // owner 에게 안 보이는지(row 부재)를 검증한다.
    await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${privCh.body.id}/messages`)
      .set('origin', ORIGIN)
      .set(bearer(owner.accessToken))
      .send({ content: 'owner is denied READ' });

    // summarize: OWNER 가 자기 채널을 만들었어도 명시 DENY 라 행이 없어야 한다.
    const ownerSummary = await unread.summarize(workspaceId, owner.userId);
    expect(ownerSummary.map((c) => c.channelId)).not.toContain(privCh.body.id);

    // totals: OWNER 워크스페이스 합계에도 이 채널 미반영(메시지 1 누설 없음).
    const ownerTotals = await unread.summarizeWorkspaceTotals(owner.userId);
    const ownerWs = ownerTotals.find((t) => t.workspaceId === workspaceId);
    expect(ownerWs).toBeDefined();
    expect(ownerWs?.unreadCount).toBe(0);
    void admin;
  });

  /**
   * S21 fix-forward (NIT-H): zero-channel 워크스페이스도 totals 가 한 줄(unread 0)
   * 을 반환해야 레일이 렌더된다(zero-entry undefined 회귀 방지). CTE 통합 후에도
   * LEFT JOIN 으로 유지되는지 직접 assertion.
   */
  it('summarizeWorkspaceTotals returns a zero-row for a workspace with no channels', async () => {
    const { workspaceId, member } = await seedWorkspaceWithRoles(env.baseUrl);
    // seedWorkspaceWithRoles 는 채널을 만들지 않으므로 이 워크스페이스는 채널 0개.
    const totals = await unread.summarizeWorkspaceTotals(member.userId);
    const ws = totals.find((t) => t.workspaceId === workspaceId);
    expect(ws).toBeDefined();
    expect(ws?.unreadCount).toBe(0);
    expect(ws?.mentionCount).toBe(0);
    expect(ws?.hasMention).toBe(false);
  });
});
