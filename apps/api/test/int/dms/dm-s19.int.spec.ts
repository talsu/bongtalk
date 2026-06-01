import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { bearer, makeFriends, setupDmIntEnv, signup, type Actor, type DmIntEnv } from './helpers';

/**
 * S19 (하이브리드 C) — 그룹 DM 멤버 추가/강퇴/나가기 + owner 승계 + DM 수신권한 회귀 spec.
 *
 *  - FR-DM-07: 멤버 추가 — owner-only, cap 20→422, 부분추가금지, 재진입 visibleFrom.
 *  - FR-DM-08: 강퇴 — owner-only/1:1 403/자기-강퇴 403, soft-leave 비가시.
 *  - FR-DM-09: 나가기 — owner 승계(joinedAt 최古), 마지막멤버 Channel.deletedAt,
 *              9개 read-path 비가시.
 *  - FR-DM-12: dm-privacy WORKSPACE_MEMBER 403 + EVERYONE/friend 통과.
 *
 * ★ 불변 계약 검증: soft-leave 후 list / getGroupMembers / room override 가
 * leaver 를 즉시 비멤버 취급(allowMask=0 + leftAt 원자 세팅).
 */
describe('S19 DM membership/owner/privacy (int)', () => {
  let env: DmIntEnv;

  beforeAll(async () => {
    env = await setupDmIntEnv();
  }, 240_000);

  afterAll(async () => {
    await env.stop();
  }, 60_000);

  /** owner(a) + 멤버 set 으로 전역 그룹 DM 개설. 모든 멤버는 a 와 친구. */
  async function makeGroup(owner: Actor, members: Actor[]): Promise<string> {
    for (const m of members) await makeFriends(env.baseUrl, owner, m);
    const grp = await request(env.baseUrl)
      .post('/me/dms/groups')
      .set(bearer(owner.accessToken))
      .send({ memberIds: members.map((m) => m.userId) });
    if (grp.status >= 400) throw new Error(`makeGroup: ${grp.status} ${grp.text}`);
    return grp.body.channelId as string;
  }

  async function activeMemberIds(channelId: string): Promise<string[]> {
    const rows = await env.prisma.channelPermissionOverride.findMany({
      where: { channelId, principalType: 'USER', allowMask: { gt: 0 } },
      select: { principalId: true },
    });
    return rows.map((r) => r.principalId).sort();
  }

  // ── FR-DM-07: 멤버 추가 ────────────────────────────────────────────────
  it('FR-DM-07: owner 가 멤버를 추가하면 현역 멤버 set 에 들어간다', async () => {
    const a = await signup(env.baseUrl, 's19a');
    const b = await signup(env.baseUrl, 's19b');
    const c = await signup(env.baseUrl, 's19c');
    const d = await signup(env.baseUrl, 's19d');
    const channelId = await makeGroup(a, [b, c]);
    await makeFriends(env.baseUrl, a, d);

    const res = await request(env.baseUrl)
      .post(`/me/dms/${channelId}/participants`)
      .set(bearer(a.accessToken))
      .send({ userIds: [d.userId] });
    expect(res.status).toBe(201);
    expect(res.body.addedUserIds).toEqual([d.userId]);

    const members = await activeMemberIds(channelId);
    expect(members).toContain(d.userId);
    expect(members).toHaveLength(4);
  });

  it('FR-DM-07: owner 가 아니면 추가 403', async () => {
    const a = await signup(env.baseUrl, 's19na');
    const b = await signup(env.baseUrl, 's19nb');
    const c = await signup(env.baseUrl, 's19nc');
    const channelId = await makeGroup(a, [b, c]);
    await makeFriends(env.baseUrl, b, c);

    const res = await request(env.baseUrl)
      .post(`/me/dms/${channelId}/participants`)
      .set(bearer(b.accessToken)) // b is a member, not owner
      .send({ userIds: [c.userId] });
    expect(res.status).toBe(403);
  });

  it('FR-DM-07: cap 20 초과 추가는 422 + 전체 롤백(부분 추가 금지)', async () => {
    // owner(a) + b + c = 3 active 로 그룹을 만든 뒤, friend-request rate limit 을
    // 피하기 위해 16명의 active 멤버를 override INSERT 로 직접 seed → 19 active.
    // 그 다음 친구인 2명을 추가 시도 → 19+2=21 > 20 → 422.
    const a = await signup(env.baseUrl, 's19ca');
    const b = await signup(env.baseUrl, 's19cb');
    const c = await signup(env.baseUrl, 's19cc');
    const channelId = await makeGroup(a, [b, c]);
    expect(await activeMemberIds(channelId)).toHaveLength(3);

    // 16 phantom active members (override 직접 insert — friend gate 우회용 seed).
    const now = new Date('2025-01-01T00:00:00Z');
    const phantomIds: string[] = [];
    for (let i = 0; i < 16; i++) {
      const u = await env.prisma.user.create({
        data: {
          id: crypto.randomUUID(),
          email: `s19ph${i}-${Date.now()}@qufox.dev`,
          username: `s19ph${i}${Date.now()}`,
          passwordHash: 'x',
          allowDmFrom: 'EVERYONE',
        },
      });
      phantomIds.push(u.id);
      await env.prisma.channelPermissionOverride.create({
        data: {
          channelId,
          principalType: 'USER',
          principalId: u.id,
          allowMask: 71, // READ|WRITE|DELETE_OWN|UPLOAD (DM_ALLOW_MASK)
          denyMask: 0,
          visibleFrom: now,
          joinedAt: now,
        },
      });
    }
    expect(await activeMemberIds(channelId)).toHaveLength(19);

    const extra1 = await signup(env.baseUrl, 's19cx1');
    const extra2 = await signup(env.baseUrl, 's19cx2');
    await makeFriends(env.baseUrl, a, extra1);
    await makeFriends(env.baseUrl, a, extra2);

    const res = await request(env.baseUrl)
      .post(`/me/dms/${channelId}/participants`)
      .set(bearer(a.accessToken))
      .send({ userIds: [extra1.userId, extra2.userId] });
    expect(res.status).toBe(422);
    expect(res.body.errorCode).toBe('DM_GROUP_CAP_EXCEEDED');
    // 전체 롤백 — 둘 다 추가되지 않음.
    const members = await activeMemberIds(channelId);
    expect(members).not.toContain(extra1.userId);
    expect(members).not.toContain(extra2.userId);
    expect(members).toHaveLength(19);
  });

  it('FR-DM-07: 한 명이라도 게이트 실패하면 전체 롤백(부분 추가 금지)', async () => {
    const a = await signup(env.baseUrl, 's19pa');
    const b = await signup(env.baseUrl, 's19pb');
    const c = await signup(env.baseUrl, 's19pc');
    const channelId = await makeGroup(a, [b, c]);

    const friend = await signup(env.baseUrl, 's19pf');
    const stranger = await signup(env.baseUrl, 's19px'); // NOT a friend of a
    await makeFriends(env.baseUrl, a, friend);

    const res = await request(env.baseUrl)
      .post(`/me/dms/${channelId}/participants`)
      .set(bearer(a.accessToken))
      .send({ userIds: [friend.userId, stranger.userId] });
    // stranger fails the friend gate → 404 FRIEND_NOT_FOUND, whole tx rolls back.
    expect(res.status).toBe(404);
    const members = await activeMemberIds(channelId);
    expect(members).not.toContain(friend.userId);
    expect(members).not.toContain(stranger.userId);
  });

  it('FR-DM-07: 재진입 시 visibleFrom 이 재세팅되어 추가 이전 히스토리가 비가시', async () => {
    const a = await signup(env.baseUrl, 's19ra');
    const b = await signup(env.baseUrl, 's19rb');
    const c = await signup(env.baseUrl, 's19rc');
    const channelId = await makeGroup(a, [b, c]);

    // b leaves, then is re-added by owner.
    const leave = await request(env.baseUrl)
      .delete(`/me/dms/${channelId}/participants/me`)
      .set(bearer(b.accessToken));
    expect(leave.status).toBe(204);

    // record b's pre-rejoin visibleFrom for comparison.
    const before = await env.prisma.channelPermissionOverride.findFirst({
      where: { channelId, principalType: 'USER', principalId: b.userId },
      select: { visibleFrom: true, leftAt: true },
    });
    expect(before?.leftAt).not.toBeNull();

    const readd = await request(env.baseUrl)
      .post(`/me/dms/${channelId}/participants`)
      .set(bearer(a.accessToken))
      .send({ userIds: [b.userId] });
    expect(readd.status).toBe(201);

    const after = await env.prisma.channelPermissionOverride.findFirst({
      where: { channelId, principalType: 'USER', principalId: b.userId },
      select: { visibleFrom: true, leftAt: true, allowMask: true },
    });
    // re-entry restores membership (row UPDATE, not DELETE) + clears leftAt + bumps visibleFrom.
    expect(after?.leftAt).toBeNull();
    expect(after?.allowMask).toBeGreaterThan(0);
    expect(after!.visibleFrom!.getTime()).toBeGreaterThanOrEqual(before!.visibleFrom!.getTime());
  });

  // ── FR-DM-08: 강퇴 ─────────────────────────────────────────────────────
  it('FR-DM-08: owner 가 멤버를 강퇴하면 soft-leave 되어 read-path 에서 비가시', async () => {
    const a = await signup(env.baseUrl, 's19ka');
    const b = await signup(env.baseUrl, 's19kb');
    const c = await signup(env.baseUrl, 's19kc');
    const channelId = await makeGroup(a, [b, c]);

    const res = await request(env.baseUrl)
      .delete(`/me/dms/${channelId}/participants/${b.userId}`)
      .set(bearer(a.accessToken));
    expect(res.status).toBe(204);

    // ★ 불변 계약: leftAt + allowMask=0 원자 세팅.
    const row = await env.prisma.channelPermissionOverride.findFirst({
      where: { channelId, principalType: 'USER', principalId: b.userId },
      select: { allowMask: true, denyMask: true, leftAt: true },
    });
    expect(row?.allowMask).toBe(0);
    expect(row?.denyMask).toBe(0);
    expect(row?.leftAt).not.toBeNull();

    // read-path 1: getGroupMembers — kicked b 제외.
    const members = await request(env.baseUrl)
      .get(`/me/dms/groups/${channelId}/members`)
      .set(bearer(a.accessToken));
    const memberIds = members.body.items.map((m: { userId: string }) => m.userId);
    expect(memberIds).not.toContain(b.userId);

    // read-path 2: kicked b 는 더 이상 그룹 목록에서 이 채널을 못 본다(404 또는 미포함).
    const bGroups = await request(env.baseUrl).get('/me/dms/groups').set(bearer(b.accessToken));
    const bChannelIds = bGroups.body.items.map((i: { channelId: string }) => i.channelId);
    expect(bChannelIds).not.toContain(channelId);

    // read-path 3: kicked b 는 getGroupMembers 404(비멤버).
    const bMembers = await request(env.baseUrl)
      .get(`/me/dms/groups/${channelId}/members`)
      .set(bearer(b.accessToken));
    expect(bMembers.status).toBe(404);

    // ★ BLOCKER 회귀: 잔여 멤버 c 가 보는 /me/dms/groups 의 해당 채널
    // memberIds / participants 에 kicked b 가 더 이상 노출되지 않는다(★불변
    // 계약). 이전 listGroups members CTE 는 allowMask 필터가 없어 soft-left/kicked
    // 멤버 UUID 가 잔여 멤버 목록에 계속 노출됐다(getGroupMembers·leaver 본인만
    // 검증하던 기존 테스트가 놓친 경로).
    const cGroups = await request(env.baseUrl).get('/me/dms/groups').set(bearer(c.accessToken));
    expect(cGroups.status).toBe(200);
    const cRow = cGroups.body.items.find(
      (i: { channelId: string }) => i.channelId === channelId,
    ) as { memberIds: string[]; participants: Array<{ userId: string }> } | undefined;
    expect(cRow).toBeDefined();
    // memberIds(전체 id 집합)에 kicked b 없음.
    expect(cRow!.memberIds).not.toContain(b.userId);
    // participants(≤5 표시 슬라이스)에도 kicked b 없음.
    expect(cRow!.participants.map((p) => p.userId)).not.toContain(b.userId);
    // 잔여는 owner a + c 두 명.
    expect(cRow!.memberIds.sort()).toEqual([a.userId, c.userId].sort());
  });

  it('FR-DM-08: 1:1 DM 강퇴는 403', async () => {
    const a = await signup(env.baseUrl, 's191a');
    const b = await signup(env.baseUrl, 's191b');
    await makeFriends(env.baseUrl, a, b);
    const dm = await request(env.baseUrl)
      .post('/me/dms')
      .set(bearer(a.accessToken))
      .send({ userId: b.userId });
    expect(dm.status).toBe(201);
    const channelId = dm.body.channelId as string;

    const res = await request(env.baseUrl)
      .delete(`/me/dms/${channelId}/participants/${b.userId}`)
      .set(bearer(a.accessToken));
    expect(res.status).toBe(403);
  });

  it('FR-DM-08: owner 자기-강퇴는 403(leave 경로 유도)', async () => {
    const a = await signup(env.baseUrl, 's19sa');
    const b = await signup(env.baseUrl, 's19sb');
    const c = await signup(env.baseUrl, 's19sc');
    const channelId = await makeGroup(a, [b, c]);

    const res = await request(env.baseUrl)
      .delete(`/me/dms/${channelId}/participants/${a.userId}`)
      .set(bearer(a.accessToken));
    expect(res.status).toBe(403);
  });

  // ── FR-DM-09: 나가기 + owner 승계 ──────────────────────────────────────
  it('FR-DM-09: owner 가 나가면 joinedAt 최古 잔여 멤버로 승계된다', async () => {
    const a = await signup(env.baseUrl, 's19oa'); // owner, joins first
    const b = await signup(env.baseUrl, 's19ob');
    const c = await signup(env.baseUrl, 's19oc');
    const channelId = await makeGroup(a, [b, c]);

    // 명시적으로 joinedAt 순서를 b < c 로 보정(개설 동시각 tie-break 안정화).
    const t0 = new Date('2025-01-01T00:00:00Z');
    await env.prisma.channelPermissionOverride.updateMany({
      where: { channelId, principalType: 'USER', principalId: b.userId },
      data: { joinedAt: new Date(t0.getTime() + 1000) },
    });
    await env.prisma.channelPermissionOverride.updateMany({
      where: { channelId, principalType: 'USER', principalId: c.userId },
      data: { joinedAt: new Date(t0.getTime() + 2000) },
    });

    const res = await request(env.baseUrl)
      .delete(`/me/dms/${channelId}/participants/me`)
      .set(bearer(a.accessToken));
    expect(res.status).toBe(204);

    const channel = await env.prisma.channel.findUnique({
      where: { id: channelId },
      select: { ownerId: true, deletedAt: true },
    });
    // b joined before c → b succeeds owner.
    expect(channel?.ownerId).toBe(b.userId);
    expect(channel?.deletedAt).toBeNull();

    // a is no longer active.
    const members = await activeMemberIds(channelId);
    expect(members).not.toContain(a.userId);
  });

  it('FR-DM-09: 마지막 멤버가 나가면 Channel.deletedAt 이 찍힌다', async () => {
    const a = await signup(env.baseUrl, 's19la');
    const b = await signup(env.baseUrl, 's19lb');
    const c = await signup(env.baseUrl, 's19lc');
    const channelId = await makeGroup(a, [b, c]);

    for (const actor of [b, c, a]) {
      const res = await request(env.baseUrl)
        .delete(`/me/dms/${channelId}/participants/me`)
        .set(bearer(actor.accessToken));
      expect(res.status).toBe(204);
    }

    const channel = await env.prisma.channel.findUnique({
      where: { id: channelId },
      select: { deletedAt: true },
    });
    expect(channel?.deletedAt).not.toBeNull();
  });

  it('FR-DM-09: 비멤버의 나가기는 404', async () => {
    const a = await signup(env.baseUrl, 's19xa');
    const b = await signup(env.baseUrl, 's19xb');
    const c = await signup(env.baseUrl, 's19xc');
    const stranger = await signup(env.baseUrl, 's19xs');
    const channelId = await makeGroup(a, [b, c]);

    const res = await request(env.baseUrl)
      .delete(`/me/dms/${channelId}/participants/me`)
      .set(bearer(stranger.accessToken));
    expect(res.status).toBe(404);
  });

  // ── FR-DM-12: DM 수신권한 ──────────────────────────────────────────────
  it('FR-DM-12: PATCH /users/me/dm-privacy 가 allowDmFrom 을 갱신한다', async () => {
    const a = await signup(env.baseUrl, 's19va');

    const res = await request(env.baseUrl)
      .patch('/users/me/dm-privacy')
      .set(bearer(a.accessToken))
      .send({ allowDmFrom: 'EVERYONE' });
    expect(res.status).toBe(200);
    expect(res.body.allowDmFrom).toBe('EVERYONE');

    const row = await env.prisma.user.findUnique({
      where: { id: a.userId },
      select: { allowDmFrom: true },
    });
    expect(row?.allowDmFrom).toBe('EVERYONE');
  });

  it('FR-DM-12: 잘못된 값(FRIENDS_ONLY 포함)은 VALIDATION_FAILED', async () => {
    const a = await signup(env.baseUrl, 's19wa');
    const res = await request(env.baseUrl)
      .patch('/users/me/dm-privacy')
      .set(bearer(a.accessToken))
      .send({ allowDmFrom: 'FRIENDS_ONLY' });
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe('VALIDATION_FAILED');
  });

  // HIGH fix-forward: SetDmPrivacyDto + 글로벌 ValidationPipe
  // (whitelist / forbidNonWhitelisted) 검증.
  it('FR-DM-12: allowDmFrom 누락은 400(VALIDATION_FAILED)', async () => {
    const a = await signup(env.baseUrl, 's19ma');
    const res = await request(env.baseUrl)
      .patch('/users/me/dm-privacy')
      .set(bearer(a.accessToken))
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe('VALIDATION_FAILED');
  });

  it('FR-DM-12: 화이트리스트 외 추가 필드는 400(forbidNonWhitelisted)', async () => {
    const a = await signup(env.baseUrl, 's19fa');
    const res = await request(env.baseUrl)
      .patch('/users/me/dm-privacy')
      .set(bearer(a.accessToken))
      .send({ allowDmFrom: 'EVERYONE', sneaky: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe('VALIDATION_FAILED');
  });

  it('FR-DM-12: WORKSPACE_MEMBER 인 상대에게 공통 워크스페이스/친구 아니면 DM 개시 403', async () => {
    const a = await signup(env.baseUrl, 's19da');
    const b = await signup(env.baseUrl, 's19db');
    // a와 b는 친구가 아니고 공통 워크스페이스도 없다. b 는 default(WORKSPACE_MEMBER).
    // 친구가 아니라서 우선 친구 게이트(FRIEND_NOT_FOUND, 404)에 먼저 걸린다 —
    // 친구를 맺어 친구 게이트를 통과시킨 뒤 b 가 EVERYONE 이 아닌 상태에서 privacy
    // 게이트를 'friend' 폴백으로 통과하는지 확인한다.
    await makeFriends(env.baseUrl, a, b);
    const res = await request(env.baseUrl)
      .post('/me/dms')
      .set(bearer(a.accessToken))
      .send({ userId: b.userId });
    // friend 폴백 → privacy 게이트 통과(WORKSPACE_MEMBER 이지만 friend).
    expect(res.status).toBe(201);
  });

  it('FR-DM-12: EVERYONE 으로 열어두면 친구가 아니어도 privacy 게이트는 통과(친구 게이트만 잔존)', async () => {
    const a = await signup(env.baseUrl, 's19ea');
    const b = await signup(env.baseUrl, 's19eb');
    await request(env.baseUrl)
      .patch('/users/me/dm-privacy')
      .set(bearer(b.accessToken))
      .send({ allowDmFrom: 'EVERYONE' });

    // 친구가 아니므로 친구 게이트(FRIEND_NOT_FOUND, 404)에 막힌다 — privacy 게이트는
    // EVERYONE 이라 통과하지만 1:1 DM 은 친구 게이트가 선행한다.
    const res = await request(env.baseUrl)
      .post('/me/dms')
      .set(bearer(a.accessToken))
      .send({ userId: b.userId });
    expect(res.status).toBe(404);
    expect(res.body.errorCode).toBe('FRIEND_NOT_FOUND');
  });
});
