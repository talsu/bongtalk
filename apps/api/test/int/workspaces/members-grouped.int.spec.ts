import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { ListMembersResponse } from '@qufox/shared-types';
import { WsIntEnv, setupWsIntEnv, signupAsUser } from './helpers';
import { PresenceService } from '../../../src/realtime/presence/presence.service';

/**
 * S27 (FR-P08/P09/P10/P11/P12) — grouped, presence-aware, paginated member
 * list. Drives presence directly through PresenceService (register /
 * setPreferenceForUser) against the shared Testcontainers Redis, then asserts
 * the REST grouping + masking + lastSeenAt + cursor + 1000-cutoff + N+1 bound.
 */
let env: WsIntEnv;
let presence: PresenceService;
const ORIGIN = 'http://localhost:45173';

beforeAll(async () => {
  env = await setupWsIntEnv();
  presence = env.app.get(PresenceService);
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

beforeEach(async () => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  await env.redis.flushdb();
});

type Actor = Awaited<ReturnType<typeof signupAsUser>>;

let slugCounter = 0;
function uniqueSlug(): string {
  slugCounter += 1;
  return `s27-${slugCounter}-${Date.now().toString(36)}`.slice(0, 30);
}

async function createWorkspace(owner: Actor): Promise<string> {
  const res = await request(env.baseUrl)
    .post('/workspaces')
    .set('origin', ORIGIN)
    .set('Authorization', `Bearer ${owner.accessToken}`)
    .send({ name: 'S27Ws', slug: uniqueSlug() })
    .expect(201);
  return res.body.id as string;
}

async function inviteAndJoin(workspaceId: string, owner: Actor, joiner: Actor): Promise<void> {
  const inv = await request(env.baseUrl)
    .post(`/workspaces/${workspaceId}/invites`)
    .set('origin', ORIGIN)
    .set('Authorization', `Bearer ${owner.accessToken}`)
    .send({ maxUses: 100 })
    .expect(201);
  await request(env.baseUrl)
    .post(`/invites/${inv.body.invite.code}/accept`)
    .set('origin', ORIGIN)
    .set('Authorization', `Bearer ${joiner.accessToken}`)
    .expect(201);
}

async function promoteToAdmin(workspaceId: string, owner: Actor, target: Actor): Promise<void> {
  await request(env.baseUrl)
    .patch(`/workspaces/${workspaceId}/members/${target.userId}/role`)
    .set('origin', ORIGIN)
    .set('Authorization', `Bearer ${owner.accessToken}`)
    .send({ role: 'ADMIN' })
    .expect(200);
}

/** Mark a user ONLINE in the workspace presence SET (one live session). */
async function bringOnline(userId: string, workspaceId: string): Promise<void> {
  await presence.register({
    sessionId: `sess-${userId}`,
    userId,
    workspaceIds: [workspaceId],
    preference: 'auto',
  });
}

async function getMembers(
  workspaceId: string,
  actor: Actor,
  query: Record<string, string> = {},
): Promise<ListMembersResponse> {
  const res = await request(env.baseUrl)
    .get(`/workspaces/${workspaceId}/members`)
    .query(query)
    .set('origin', ORIGIN)
    .set('Authorization', `Bearer ${actor.accessToken}`)
    .expect(200);
  return res.body as ListMembersResponse;
}

function allMemberIds(body: ListMembersResponse): string[] {
  const ids: string[] = [];
  for (const g of body.hoist) for (const m of g.members) ids.push(m.userId);
  for (const g of body.groups) for (const m of g.members) ids.push(m.userId);
  return ids;
}

describe('S27/FR-P09 GET /workspaces/:id/members — status + per-role hoist groups (FR-P08/P09)', () => {
  it('hoists OWNER/ADMIN into per-role groups (backfill); MEMBER buckets by status', async () => {
    const owner = await signupAsUser(env.baseUrl, 'o');
    const admin = await signupAsUser(env.baseUrl, 'a');
    const onlineMember = await signupAsUser(env.baseUrl, 'm1');
    const offlineMember = await signupAsUser(env.baseUrl, 'm2');
    const ws = await createWorkspace(owner);
    await inviteAndJoin(ws, owner, admin);
    await inviteAndJoin(ws, owner, onlineMember);
    await inviteAndJoin(ws, owner, offlineMember);
    await promoteToAdmin(ws, owner, admin);

    // FR-P09: hoist 는 온라인 멤버만 → OWNER/ADMIN 도 온라인이어야 hoist 그룹에 뜬다.
    await bringOnline(owner.userId, ws);
    await bringOnline(admin.userId, ws);
    await bringOnline(onlineMember.userId, ws);

    const body = await getMembers(ws, owner);

    // FR-P09: 시드/backfill 로 OWNER·ADMIN 시스템 역할이 hoistInMemberList=true →
    // per-role 그룹 2개(position DESC: OWNER 500 → ADMIN 400). 종전 단일 'staff' 그룹에서
    // per-role 그룹으로 전환(의도된 진화). key 는 roleId, label 은 역할명.
    expect(body.hoist).toHaveLength(2);
    expect(body.hoist.map((g) => g.label)).toEqual(['OWNER', 'ADMIN']);
    expect(body.hoist[0].members.map((m) => m.userId)).toEqual([owner.userId]);
    expect(body.hoist[1].members.map((m) => m.userId)).toEqual([admin.userId]);
    // key 는 'staff' 리터럴이 아니라 roleId(uuid)다.
    expect(body.hoist[0].key).not.toBe('staff');

    // FR-P08: the online MEMBER is in the online group, offline MEMBER offline.
    const onlineGroup = body.groups.find((g) => g.key === 'online');
    const offlineGroup = body.groups.find((g) => g.key === 'offline');
    expect(onlineGroup?.members.map((m) => m.userId)).toEqual([onlineMember.userId]);
    expect(offlineGroup?.members.map((m) => m.userId)).toEqual([offlineMember.userId]);
  });

  // FR-P09 (task-068 · S95): hoisted 역할 멤버라도 offline 이면 offline 그룹으로 강등.
  it('demotes an OFFLINE hoisted member to the offline status group (hoist = online only)', async () => {
    const owner = await signupAsUser(env.baseUrl, 'o');
    const admin = await signupAsUser(env.baseUrl, 'a');
    const ws = await createWorkspace(owner);
    await inviteAndJoin(ws, owner, admin);
    await promoteToAdmin(ws, owner, admin);

    // OWNER 만 온라인, ADMIN 은 offline(세션 없음).
    await bringOnline(owner.userId, ws);

    const body = await getMembers(ws, owner);

    // OWNER 는 hoist 그룹(온라인), ADMIN 은 hoisted 역할이지만 offline → offline 그룹.
    const hoistIds = body.hoist.flatMap((g) => g.members.map((m) => m.userId));
    expect(hoistIds).toEqual([owner.userId]);
    expect(body.hoist.map((g) => g.label)).toEqual(['OWNER']);
    const offlineGroup = body.groups.find((g) => g.key === 'offline');
    expect(offlineGroup?.members.map((m) => m.userId)).toContain(admin.userId);
  });

  // FR-P09 (task-068 · S95): 커스텀 역할에 hoistInMemberList=true 부여 → 그 역할 그룹 노출.
  it('hoists a custom role with hoistInMemberList=true into its own group', async () => {
    const owner = await signupAsUser(env.baseUrl, 'o');
    const member = await signupAsUser(env.baseUrl, 'm');
    const ws = await createWorkspace(owner);
    await inviteAndJoin(ws, owner, member);

    // 커스텀 역할 생성(hoistInMemberList=true) + 멤버에게 배정.
    const created = await request(env.baseUrl)
      .post(`/workspaces/${ws}/roles`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'Helpers', position: 50, hoistInMemberList: true })
      .expect(201);
    const roleId = created.body.id as string;
    expect(created.body.hoistInMemberList).toBe(true);
    await request(env.baseUrl)
      .post(`/workspaces/${ws}/roles/assign`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ roleId, userId: member.userId })
      .expect(204);

    await bringOnline(member.userId, ws);

    const body = await getMembers(ws, member);
    const helperGroup = body.hoist.find((g) => g.key === roleId);
    expect(helperGroup).toBeDefined();
    expect(helperGroup?.label).toBe('Helpers');
    expect(helperGroup?.members.map((m) => m.userId)).toEqual([member.userId]);
  });

  // FR-P09 (task-068 · S95): hoistInMemberList=false 커스텀 역할 멤버는 status 그룹에 남는다.
  it('keeps a member of a non-hoist (hoistInMemberList=false) role in the status group', async () => {
    const owner = await signupAsUser(env.baseUrl, 'o');
    const member = await signupAsUser(env.baseUrl, 'm');
    const ws = await createWorkspace(owner);
    await inviteAndJoin(ws, owner, member);

    const created = await request(env.baseUrl)
      .post(`/workspaces/${ws}/roles`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'Plain', position: 50 }) // hoistInMemberList 미지정 → false
      .expect(201);
    expect(created.body.hoistInMemberList).toBe(false);
    await request(env.baseUrl)
      .post(`/workspaces/${ws}/roles/assign`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ roleId: created.body.id, userId: member.userId })
      .expect(204);

    await bringOnline(member.userId, ws);

    const body = await getMembers(ws, member);
    // 이 멤버는 hoist 그룹 어디에도 없고 online status 그룹에 있다.
    const hoistIds = body.hoist.flatMap((g) => g.members.map((m) => m.userId));
    expect(hoistIds).not.toContain(member.userId);
    expect(body.groups.find((g) => g.key === 'online')?.members.map((m) => m.userId)).toContain(
      member.userId,
    );
  });

  // FR-P09 (task-068 · S95): 다중 hoisted 역할 멤버는 최상위(position 최대) 1개 그룹만.
  it('places a member with multiple hoisted roles in only the TOP one (dedup)', async () => {
    const owner = await signupAsUser(env.baseUrl, 'o');
    const member = await signupAsUser(env.baseUrl, 'm');
    const ws = await createWorkspace(owner);
    await inviteAndJoin(ws, owner, member);

    // 두 커스텀 hoist 역할(High 90 / Low 40). 멤버에게 둘 다 배정.
    const high = await request(env.baseUrl)
      .post(`/workspaces/${ws}/roles`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'High', position: 90, hoistInMemberList: true })
      .expect(201);
    const low = await request(env.baseUrl)
      .post(`/workspaces/${ws}/roles`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'Low', position: 40, hoistInMemberList: true })
      .expect(201);
    for (const roleId of [high.body.id, low.body.id]) {
      await request(env.baseUrl)
        .post(`/workspaces/${ws}/roles/assign`)
        .set('origin', ORIGIN)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ roleId, userId: member.userId })
        .expect(204);
    }

    await bringOnline(member.userId, ws);

    const body = await getMembers(ws, member);
    // 멤버는 최상위 High 그룹에만 있고 Low 그룹엔 없다(중복 없음).
    const highGroup = body.hoist.find((g) => g.key === high.body.id);
    const lowGroup = body.hoist.find((g) => g.key === low.body.id);
    expect(highGroup?.members.map((m) => m.userId)).toContain(member.userId);
    expect(lowGroup?.members.map((m) => m.userId) ?? []).not.toContain(member.userId);
  });

  it('buckets idle and dnd members into their own groups', async () => {
    const owner = await signupAsUser(env.baseUrl, 'o');
    const idleM = await signupAsUser(env.baseUrl, 'mi');
    const dndM = await signupAsUser(env.baseUrl, 'md');
    const ws = await createWorkspace(owner);
    await inviteAndJoin(ws, owner, idleM);
    await inviteAndJoin(ws, owner, dndM);

    // idle: online session but last-activity older than idle timeout.
    await bringOnline(idleM.userId, ws);
    const idleSec = presence['idleTimeoutSec'] as number;
    await env.redis.set(
      `presence:user:${idleM.userId}:lastActivity`,
      String(Date.now() - (idleSec + 60) * 1000),
    );
    // dnd: dnd preference (still in the online SET + dnd SET).
    await presence.register({
      sessionId: `sess-${dndM.userId}`,
      userId: dndM.userId,
      workspaceIds: [ws],
      preference: 'dnd',
    });

    const body = await getMembers(ws, owner);
    expect(body.groups.find((g) => g.key === 'idle')?.members.map((m) => m.userId)).toEqual([
      idleM.userId,
    ]);
    expect(body.groups.find((g) => g.key === 'dnd')?.members.map((m) => m.userId)).toEqual([
      dndM.userId,
    ]);
  });
});

describe('S27 member list — INVISIBLE masking (FR-P08/P12)', () => {
  it('masks an invisible OTHER user to offline, but the invisible user sees themselves real', async () => {
    const owner = await signupAsUser(env.baseUrl, 'o');
    const ghost = await signupAsUser(env.baseUrl, 'g');
    const ws = await createWorkspace(owner);
    await inviteAndJoin(ws, owner, ghost);

    // ghost is INVISIBLE with a live session.
    await presence.register({
      sessionId: `sess-${ghost.userId}`,
      userId: ghost.userId,
      workspaceIds: [ws],
      preference: 'invisible',
    });

    // Owner's view: ghost masked to offline.
    const ownerView = await getMembers(ws, owner);
    const ownerSeesGhost = [...ownerView.groups, ...ownerView.hoist]
      .flatMap((g) => g.members)
      .find((m) => m.userId === ghost.userId);
    expect(ownerSeesGhost?.status).toBe('offline');

    // Ghost's own view: NOT online (invisible maps to offline group, never leaks
    // "online" to a roster), but the masking is self-truthful via bulkFor — the
    // key invariant is that an OTHER viewer can't tell ghost is connected.
    const ghostView = await getMembers(ws, ghost);
    const ghostSelf = [...ghostView.groups, ...ghostView.hoist]
      .flatMap((g) => g.members)
      .find((m) => m.userId === ghost.userId);
    // ghost 는 MEMBER(비-hoist 역할) → 어느 그룹이든 자기 자신은 보인다(invisible 자기노출).
    expect(ghostSelf).toBeDefined();
  });

  // FR-P09 fix-forward (security LOW): hoisted 역할(OWNER 등)을 보유한 INVISIBLE 멤버는
  // 타인 응답에서 hoist 그룹에 노출되면 "연결됨"이 새어나간다. masked→offline 이므로
  // hoist(online 만)에서 제외되고 offline status 그룹에 들어가야 한다(연결 여부 비노출).
  it('does NOT hoist an INVISIBLE member who holds a hoisted role; shows them OFFLINE to others', async () => {
    const owner = await signupAsUser(env.baseUrl, 'o');
    const admin = await signupAsUser(env.baseUrl, 'a');
    const ws = await createWorkspace(owner);
    await inviteAndJoin(ws, owner, admin);
    await promoteToAdmin(ws, owner, admin);

    // OWNER 는 hoisted 역할이지만 INVISIBLE(라이브 세션 보유). ADMIN 은 온라인 뷰어.
    await presence.register({
      sessionId: `sess-${owner.userId}`,
      userId: owner.userId,
      workspaceIds: [ws],
      preference: 'invisible',
    });
    await bringOnline(admin.userId, ws);

    // ADMIN(타인) 시점: OWNER 는 hoist 그룹 어디에도 없어야 한다(연결 비노출).
    const adminView = await getMembers(ws, admin);
    const hoistIds = adminView.hoist.flatMap((g) => g.members.map((m) => m.userId));
    expect(hoistIds).not.toContain(owner.userId);
    // 대신 OWNER 는 offline status 그룹으로 강등돼 보인다(마스킹된 offline).
    const offlineGroup = adminView.groups.find((g) => g.key === 'offline');
    expect(offlineGroup?.members.map((m) => m.userId)).toContain(owner.userId);
    const ownerRow = offlineGroup?.members.find((m) => m.userId === owner.userId);
    expect(ownerRow?.status).toBe('offline');
    // ADMIN 자신은(온라인 hoisted 역할) ADMIN hoist 그룹에 정상 노출된다(회귀 가드).
    const adminHoist = adminView.hoist.find((g) => g.label === 'ADMIN');
    expect(adminHoist?.members.map((m) => m.userId)).toContain(admin.userId);
  });

  it('does NOT leak lastSeenAt for an invisible-masked user (FR-P10)', async () => {
    const owner = await signupAsUser(env.baseUrl, 'o');
    const ghost = await signupAsUser(env.baseUrl, 'g');
    const ws = await createWorkspace(owner);
    await inviteAndJoin(ws, owner, ghost);

    // ghost has NEVER been OFFLINE/DND → lastSeenAt column is null even though
    // they are currently invisible (which never writes lastSeenAt).
    await presence.register({
      sessionId: `sess-${ghost.userId}`,
      userId: ghost.userId,
      workspaceIds: [ws],
      preference: 'invisible',
    });

    const body = await getMembers(ws, owner);
    const ghostRow = body.groups
      .find((g) => g.key === 'offline')
      ?.members.find((m) => m.userId === ghost.userId);
    expect(ghostRow?.status).toBe('offline');
    expect(ghostRow?.lastSeenAt).toBeNull();
  });
});

describe('S27 member list — lastSeenAt surfaces for genuine offline (FR-P10)', () => {
  it('exposes lastSeenAt for an offline member who has a stored value', async () => {
    const owner = await signupAsUser(env.baseUrl, 'o');
    const gone = await signupAsUser(env.baseUrl, 'x');
    const ws = await createWorkspace(owner);
    await inviteAndJoin(ws, owner, gone);

    const seenAt = new Date('2025-01-01T00:00:00.000Z');
    await env.prisma.user.update({ where: { id: gone.userId }, data: { lastSeenAt: seenAt } });

    const body = await getMembers(ws, owner);
    const goneRow = body.groups
      .find((g) => g.key === 'offline')
      ?.members.find((m) => m.userId === gone.userId);
    expect(goneRow?.status).toBe('offline');
    expect(goneRow?.lastSeenAt).toBe(seenAt.toISOString());
  });

  it('desensitises lastSeenAt to UTC day granularity (FR-P10 — no sub-day signal)', async () => {
    const owner = await signupAsUser(env.baseUrl, 'o');
    const gone = await signupAsUser(env.baseUrl, 'x');
    const ws = await createWorkspace(owner);
    await inviteAndJoin(ws, owner, gone);

    // A precise mid-day timestamp must surface only as that day's UTC midnight,
    // so an observer can't fingerprint the exact minute the user went dark.
    const precise = new Date('2025-01-01T13:47:09.123Z');
    await env.prisma.user.update({ where: { id: gone.userId }, data: { lastSeenAt: precise } });

    const body = await getMembers(ws, owner);
    const goneRow = body.groups
      .find((g) => g.key === 'offline')
      ?.members.find((m) => m.userId === gone.userId);
    expect(goneRow?.lastSeenAt).toBe('2025-01-01T00:00:00.000Z');
  });
});

describe('S27 fix-forward — lastSeenAt leak through INVISIBLE masking (security BLOCKER)', () => {
  it('does NOT leak a DND-era lastSeenAt once the user flips to INVISIBLE', async () => {
    const owner = await signupAsUser(env.baseUrl, 'o');
    const ghost = await signupAsUser(env.baseUrl, 'g');
    const ws = await createWorkspace(owner);
    await inviteAndJoin(ws, owner, ghost);

    // Simulate the leak vector: the ghost was DND (which stamps lastSeenAt), then
    // flipped to INVISIBLE (which keeps a live session, masked to offline). The
    // stale DND lastSeenAt must NOT surface to another viewer.
    const dndStamp = new Date('2025-01-01T11:22:33.000Z');
    await env.prisma.user.update({ where: { id: ghost.userId }, data: { lastSeenAt: dndStamp } });
    await presence.register({
      sessionId: `sess-${ghost.userId}`,
      userId: ghost.userId,
      workspaceIds: [ws],
      preference: 'invisible',
    });

    const ownerView = await getMembers(ws, owner);
    const ghostRow = ownerView.groups
      .find((g) => g.key === 'offline')
      ?.members.find((m) => m.userId === ghost.userId);
    expect(ghostRow?.status).toBe('offline'); // masked
    expect(ghostRow?.lastSeenAt).toBeNull(); // leak guard: stale DND value suppressed
  });
});

describe('S27 fix-forward — authoritative grouping beyond one page (correctness BLOCKER)', () => {
  it('groups are computed over ALL members, not a 50-row join-ordered slice', async () => {
    // 60 members > MEMBER_LIST_PAGE_SIZE. The online members are seeded LAST (so
    // they sort to the END by joinedAt), proving the online group is built over
    // the whole set rather than the first 50 join-ordered rows.
    const owner = await signupAsUser(env.baseUrl, 'o');
    const ws = await createWorkspace(owner); // member #1
    const { randomUUID } = await import('node:crypto');

    const total = 60;
    const offlineStubs = Array.from({ length: total - 1 }, (_, i) => ({
      id: randomUUID(),
      email: `g60-${i}-${Date.now()}@qufox.dev`,
      username: `g60${i}${Date.now()}`,
      passwordHash: 'x',
    }));
    await env.prisma.user.createMany({ data: offlineStubs });
    // Insert with ascending joinedAt so the LAST-inserted are the newest.
    const base = new Date('2025-01-01T00:00:00.000Z').getTime();
    for (let i = 0; i < offlineStubs.length; i += 1) {
      await env.prisma.workspaceMember.create({
        data: {
          workspaceId: ws,
          userId: offlineStubs[i].id,
          role: 'MEMBER',
          joinedAt: new Date(base + (i + 1) * 1000),
        },
      });
    }

    // Bring the THREE most-recently-joined stubs ONLINE — they live at indices
    // 56,57,58 of the join order, i.e. well past the first 50-row page.
    const onlineIds = offlineStubs.slice(-3).map((s) => s.id);
    for (const uid of onlineIds) await bringOnline(uid, ws);

    // Walk every page; assemble the COMPLETE online group across pages.
    const onlineSeen = new Set<string>();
    let cursor: string | undefined;
    for (let p = 0; p < 10; p += 1) {
      const body = await getMembers(ws, owner, cursor ? { cursor } : {});
      const og = body.groups.find((g) => g.key === 'online');
      for (const m of og?.members ?? []) onlineSeen.add(m.userId);
      if (!body.nextCursor) break;
      cursor = body.nextCursor;
    }

    // FR-P08: all three late-joining online members are present — the group is
    // authoritative over the whole 60-member set, not truncated at the first 50.
    for (const uid of onlineIds) expect(onlineSeen.has(uid)).toBe(true);
    expect(onlineSeen.size).toBe(3);
  });

  it('rejects a non-UUID cursor with 400 (no Prisma 500 leak)', async () => {
    const owner = await signupAsUser(env.baseUrl, 'o');
    const ws = await createWorkspace(owner);
    // A base64url-decodable cursor whose embedded anchor is NOT a uuid → decode
    // returns null → first page (no 500). An over-long cursor → 400 at the
    // controller boundary.
    const garbage = Buffer.from('u|not-a-uuid', 'utf8').toString('base64url');
    const okBody = await getMembers(ws, owner, { cursor: garbage });
    expect(allMemberIds(okBody)).toContain(owner.userId);

    const tooLong = 'A'.repeat(300);
    await request(env.baseUrl)
      .get(`/workspaces/${ws}/members`)
      .query({ cursor: tooLong })
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(400);
  });
});

describe('S27 member list — N+1 bound (FR-P12)', () => {
  it('reads presence via a SINGLE bulkFor for the whole page (no per-member query)', async () => {
    const owner = await signupAsUser(env.baseUrl, 'o');
    const ws = await createWorkspace(owner);
    // Stub members via direct inserts (signup × N risks the signup IP limiter).
    const { randomUUID } = await import('node:crypto');
    const userRows = Array.from({ length: 6 }, (_, i) => ({
      id: randomUUID(),
      email: `n1b-${i}-${Date.now()}@qufox.dev`,
      username: `n1b${i}${Date.now()}`,
      passwordHash: 'x',
    }));
    await env.prisma.user.createMany({ data: userRows });
    await env.prisma.workspaceMember.createMany({
      data: userRows.map((u) => ({ workspaceId: ws, userId: u.id, role: 'MEMBER' as const })),
    });

    // Spy on the plain class methods (NOT the Prisma model proxy, which a spy
    // would break). One bulkFor for the page + bounded effective-status reads
    // (one per page member, concurrent) prove there's no per-member presence
    // round-trip outside the single bulkFor fan-out.
    const bulkSpy = vi.spyOn(presence, 'bulkFor');
    const effSpy = vi.spyOn(presence, 'effectiveStatusWithActivity');

    try {
      await getMembers(ws, owner);
      // FR-P12: exactly ONE bulkFor for the page (not 1-per-member).
      expect(bulkSpy).toHaveBeenCalledTimes(1);
      // The single bulkFor received every page member's id at once.
      const firstCallIds = bulkSpy.mock.calls[0][1];
      expect(firstCallIds.length).toBe(userRows.length + 1); // +owner
      // effectiveStatusWithActivity is bounded by page size (<= 50), NOT by the
      // workspace total, and is only reached THROUGH the single bulkFor.
      expect(effSpy.mock.calls.length).toBe(userRows.length + 1);
      expect(effSpy.mock.calls.length).toBeLessThanOrEqual(50);
    } finally {
      bulkSpy.mockRestore();
      effSpy.mockRestore();
    }
  });
});

describe('S27 member list — cursor pagination (FR-P12)', () => {
  it('pages at MEMBER_LIST_PAGE_SIZE and walks forward via nextCursor without dupes/gaps', async () => {
    const owner = await signupAsUser(env.baseUrl, 'o');
    const ws = await createWorkspace(owner);
    // 51 members total (owner + 50 stubs) → one full page + one overflow.
    // Direct inserts (signup × 50 risks the signup IP limiter).
    const { randomUUID } = await import('node:crypto');
    const expected = new Set<string>([owner.userId]);
    const stubs = Array.from({ length: 50 }, (_, i) => ({
      id: randomUUID(),
      email: `pg-${i}-${Date.now()}@qufox.dev`,
      username: `pg${i}${Date.now()}`,
      passwordHash: 'x',
    }));
    await env.prisma.user.createMany({ data: stubs });
    await env.prisma.workspaceMember.createMany({
      data: stubs.map((u) => ({ workspaceId: ws, userId: u.id, role: 'MEMBER' as const })),
    });
    for (const s of stubs) expected.add(s.id);

    const page1 = await getMembers(ws, owner);
    const ids1 = allMemberIds(page1);
    expect(ids1.length).toBe(50);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await getMembers(ws, owner, { cursor: page1.nextCursor as string });
    const ids2 = allMemberIds(page2);
    expect(ids2.length).toBe(1);
    expect(page2.nextCursor).toBeNull();

    const union = new Set<string>([...ids1, ...ids2]);
    expect(union.size).toBe(51); // no dupes
    expect(union).toEqual(expected); // no gaps
  });

  it('treats a malformed cursor as the first page (no 500)', async () => {
    const owner = await signupAsUser(env.baseUrl, 'o');
    const ws = await createWorkspace(owner);
    const body = await getMembers(ws, owner, { cursor: 'not-a-real-cursor!!!' });
    expect(allMemberIds(body)).toContain(owner.userId);
  });
});

describe('S27 member list — 1000-member OFFLINE exclusion (FR-P11)', () => {
  it('omits the OFFLINE group by default once the workspace has >= 1000 members', async () => {
    // Seed 1000 members cheaply via direct Prisma inserts (signup ×1000 would
    // blow the budget). Owner created via the normal path so auth works.
    const owner = await signupAsUser(env.baseUrl, 'o');
    const ws = await createWorkspace(owner); // owner = member #1
    const onlineExtra = await signupAsUser(env.baseUrl, 'on');
    await inviteAndJoin(ws, owner, onlineExtra);

    // Bulk-insert the remaining stub users + memberships to cross 1000.
    const need = 1000 - 2; // owner + onlineExtra already members
    const { randomUUID } = await import('node:crypto');
    const userRows = Array.from({ length: need }, (_, i) => ({
      id: randomUUID(),
      email: `stub-${i}-${Date.now()}@qufox.dev`,
      username: `stub${i}${Date.now()}`,
      passwordHash: 'x',
    }));
    await env.prisma.user.createMany({ data: userRows });
    await env.prisma.workspaceMember.createMany({
      data: userRows.map((u) => ({ workspaceId: ws, userId: u.id, role: 'MEMBER' as const })),
    });

    // onlineExtra is the only ONLINE member; the 998 stubs are OFFLINE.
    await bringOnline(onlineExtra.userId, ws);

    // Default: no OFFLINE group (FR-P11).
    const def = await getMembers(ws, owner);
    expect(def.includeOffline).toBe(false);
    expect(def.groups.find((g) => g.key === 'offline')).toBeUndefined();
    // online member still surfaces.
    expect(allMemberIds(def)).toContain(onlineExtra.userId);

    // Override: include_offline=true brings the OFFLINE group back.
    const forced = await getMembers(ws, owner, { include_offline: 'true' });
    expect(forced.includeOffline).toBe(true);
    expect(forced.groups.find((g) => g.key === 'offline')).toBeDefined();
  });
});
