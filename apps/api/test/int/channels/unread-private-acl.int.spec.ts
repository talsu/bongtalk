import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { bearer, type ChIntEnv, ORIGIN, seedWorkspaceWithRoles, setupChIntEnv } from './helpers';

let env: ChIntEnv;

beforeAll(async () => {
  env = await setupChIntEnv();
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
});
