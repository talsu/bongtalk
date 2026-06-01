import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DM_GROUP_UPDATED } from '../../../src/channels/events/channel-events';
import { bearer, makeFriends, setupDmIntEnv, signup, type Actor, type DmIntEnv } from './helpers';

/**
 * S20 슬라이스 — DM 검색/이름변경/아이콘/숨기기/뮤트 회귀 spec.
 *
 *  - FR-DM-04: DM 목록 검색 — q 가 group displayName/slug OR 참여자 username 에
 *              ILIKE 매칭(파라미터 바인딩). q 없으면 기존 동작.
 *  - FR-DM-05: 그룹 DM 이름 변경 — Channel.displayName 세팅(slug 불변) +
 *              dm:group_updated emit.
 *  - FR-DM-06: 그룹 DM 아이콘 — 4MB/타입/magic-bytes 거부, 업로드·삭제 +
 *              dm:group_updated emit.
 *  - FR-DM-10: DM 숨기기 — 목록 제외 + 상대방 새 메시지 자동 복원(보낸 본인 제외).
 *  - FR-DM-11: DM 뮤트 — UserChannelMute upsert + 만료 query-time 필터.
 */
describe('S20 DM search/rename/icon/hide/mute (int)', () => {
  let env: DmIntEnv;
  let emitter: EventEmitter2;

  beforeAll(async () => {
    env = await setupDmIntEnv();
    emitter = env.app.get(EventEmitter2);
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

  /** Open a 1:1 DM between two freshly-signed-up friends. */
  async function openDm(a: Actor, b: Actor): Promise<string> {
    await makeFriends(env.baseUrl, a, b);
    const dm = await request(env.baseUrl)
      .post('/me/dms')
      .set(bearer(a.accessToken))
      .send({ userId: b.userId });
    if (dm.status >= 400) throw new Error(`createDm: ${dm.status} ${dm.text}`);
    return dm.body.channelId as string;
  }

  async function sendDm(actor: Actor, channelId: string, content: string): Promise<string> {
    const res = await request(env.baseUrl)
      .post(`/me/dms/${channelId}/messages`)
      .set(bearer(actor.accessToken))
      .send({ content });
    if (res.status >= 400) throw new Error(`sendDm: ${res.status} ${res.text}`);
    return res.body.message.id as string;
  }

  // 최소 PNG 8바이트 magic + 패딩(유효 magic, 작은 크기).
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
  // GIF87a magic.
  const GIF_MAGIC = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0x00, 0x00]);

  // ── FR-DM-05: 이름 변경 + dm:group_updated ───────────────────────────────
  it('FR-DM-05: 그룹 DM 이름 변경이 displayName 을 세팅하고 dm.group_updated 를 emit 한다', async () => {
    const a = await signup(env.baseUrl, 's20ra');
    const b = await signup(env.baseUrl, 's20rb');
    const c = await signup(env.baseUrl, 's20rc');
    const channelId = await makeGroup(a, [b, c]);

    const received: Array<Record<string, unknown>> = [];
    const handler = (e: Record<string, unknown>): void => {
      received.push(e);
    };
    emitter.on(DM_GROUP_UPDATED, handler);

    const res = await request(env.baseUrl)
      .patch(`/me/dms/${channelId}`)
      .set(bearer(a.accessToken))
      .send({ name: 'Project Phoenix' });
    expect(res.status).toBe(200);
    expect(res.body.displayName).toBe('Project Phoenix');

    // slug(Channel.name)은 불변, displayName 만 갱신.
    const ch = await env.prisma.channel.findUnique({ where: { id: channelId } });
    expect(ch!.name.startsWith('gdm:')).toBe(true);
    expect(ch!.displayName).toBe('Project Phoenix');

    await env.dispatcher.drain();
    const ev = received.find((e) => (e as { channelId?: string }).channelId === channelId);
    expect(ev).toBeDefined();
    expect(ev!.displayName).toBe('Project Phoenix');
    expect(ev!.recipients).toEqual(expect.arrayContaining([a.userId, b.userId, c.userId]));
    emitter.off(DM_GROUP_UPDATED, handler);

    // listGroups 가 displayName 을 노출한다.
    const list = await request(env.baseUrl).get('/me/dms/groups').set(bearer(a.accessToken));
    const item = list.body.items.find((i: { channelId: string }) => i.channelId === channelId);
    expect(item.displayName).toBe('Project Phoenix');
  });

  it('FR-DM-05: 빈/공백 이름은 400, 100자 초과도 400, 멤버 아니면 404', async () => {
    const a = await signup(env.baseUrl, 's20rv');
    const b = await signup(env.baseUrl, 's20rw');
    const c = await signup(env.baseUrl, 's20rx');
    const outsider = await signup(env.baseUrl, 's20ry');
    const channelId = await makeGroup(a, [b, c]);

    const blank = await request(env.baseUrl)
      .patch(`/me/dms/${channelId}`)
      .set(bearer(a.accessToken))
      .send({ name: '   ' });
    expect(blank.status).toBe(400);

    const tooLong = await request(env.baseUrl)
      .patch(`/me/dms/${channelId}`)
      .set(bearer(a.accessToken))
      .send({ name: 'x'.repeat(101) });
    expect(tooLong.status).toBe(400);

    const notMember = await request(env.baseUrl)
      .patch(`/me/dms/${channelId}`)
      .set(bearer(outsider.accessToken))
      .send({ name: 'Hijack' });
    expect(notMember.status).toBe(404);
  });

  // ── FR-DM-04: 검색 ────────────────────────────────────────────────────────
  it('FR-DM-04: q 가 group displayName 으로 ILIKE 매칭한다', async () => {
    const a = await signup(env.baseUrl, 's20qa');
    const b = await signup(env.baseUrl, 's20qb');
    const c = await signup(env.baseUrl, 's20qc');
    const g1 = await makeGroup(a, [b, c]);
    const d = await signup(env.baseUrl, 's20qd');
    const e = await signup(env.baseUrl, 's20qe');
    const g2 = await makeGroup(a, [d, e]);

    await request(env.baseUrl)
      .patch(`/me/dms/${g1}`)
      .set(bearer(a.accessToken))
      .send({ name: 'Dragons Den' });
    await request(env.baseUrl)
      .patch(`/me/dms/${g2}`)
      .set(bearer(a.accessToken))
      .send({ name: 'Quiet Lounge' });

    const hit = await request(env.baseUrl)
      .get('/me/dms/groups')
      .query({ q: 'dragon' }) // case-insensitive
      .set(bearer(a.accessToken));
    expect(hit.status).toBe(200);
    const ids = hit.body.items.map((i: { channelId: string }) => i.channelId);
    expect(ids).toContain(g1);
    expect(ids).not.toContain(g2);
  });

  it('FR-DM-04: q 가 1:1 DM 상대 username 으로 ILIKE 매칭한다', async () => {
    const a = await signup(env.baseUrl, 's20ua');
    const b = await signup(env.baseUrl, 's20ub');
    const x = await signup(env.baseUrl, 'zzdistinct');
    const dmB = await openDm(a, b);
    const dmX = await openDm(a, x);

    const hit = await request(env.baseUrl)
      .get('/me/dms')
      .query({ q: 'zzdistinct' })
      .set(bearer(a.accessToken));
    expect(hit.status).toBe(200);
    const ids = hit.body.items.map((i: { channelId: string }) => i.channelId);
    expect(ids).toContain(dmX);
    expect(ids).not.toContain(dmB);
  });

  it('FR-DM-04: LIKE 메타문자(%)는 리터럴로 escape 되어 매칭되지 않는다 (injection 방지)', async () => {
    const a = await signup(env.baseUrl, 's20esc');
    const b = await signup(env.baseUrl, 's20escb');
    const dm = await openDm(a, b);
    // `%` 가 와일드카드로 동작하면 모든 DM 이 매칭될 것 — escape 되면 0건.
    const res = await request(env.baseUrl)
      .get('/me/dms')
      .query({ q: '%' })
      .set(bearer(a.accessToken));
    expect(res.status).toBe(200);
    const ids = res.body.items.map((i: { channelId: string }) => i.channelId);
    expect(ids).not.toContain(dm);
  });

  // ── FR-DM-04 (BLOCKER fix-forward): ESCAPE '\' 정/부정 회귀 ────────────────
  // displayName 에 LIKE 메타문자를 **리터럴로** 포함시킨 행과 미포함 행을 만들어,
  // escape 된 검색어로 정/부정 매칭을 동시에 검증한다. ESCAPE 가 빈 문자열로
  // 붕괴(`ESCAPE ''`)하면 `\%`/`\_` 가 와일드카드로 새어 negative 행까지 매칭돼
  // 이 테스트가 깨진다(기존 `q='%'` 테스트는 escape 깨져도 우연히 통과하므로 불충분).
  it("FR-DM-04: '%' 가 리터럴로 매칭된다 — 메타 포함 행만 hit, 미포함 행은 miss", async () => {
    const a = await signup(env.baseUrl, 's20pa');
    const b = await signup(env.baseUrl, 's20pb');
    const c = await signup(env.baseUrl, 's20pc');
    const litPct = await makeGroup(a, [b, c]); // displayName 에 리터럴 '%' 포함
    const d = await signup(env.baseUrl, 's20pd');
    const e = await signup(env.baseUrl, 's20pe');
    const noPct = await makeGroup(a, [d, e]); // 메타 미포함(같은 base 토큰)

    await request(env.baseUrl)
      .patch(`/me/dms/${litPct}`)
      .set(bearer(a.accessToken))
      .send({ name: 'rate 50% off' });
    await request(env.baseUrl)
      .patch(`/me/dms/${noPct}`)
      .set(bearer(a.accessToken))
      .send({ name: 'rate 50X off' });

    // 검색어에 리터럴 '%' 포함 → 빌더가 '\%' 로 escape → '%' 를 리터럴로 매칭.
    const hit = await request(env.baseUrl)
      .get('/me/dms/groups')
      .query({ q: '50% off' })
      .set(bearer(a.accessToken));
    expect(hit.status).toBe(200);
    const ids = hit.body.items.map((i: { channelId: string }) => i.channelId);
    // 정매칭: 리터럴 '%' 행. 부정매칭: escape 가 새면 '%' 가 와일드카드라 '50X off'
    // 까지 매칭될 것 — escape 정상이면 미포함.
    expect(ids).toContain(litPct);
    expect(ids).not.toContain(noPct);
  });

  it("FR-DM-04: '_' 가 리터럴로 매칭된다 — single-char 와일드카드가 새지 않는다", async () => {
    const a = await signup(env.baseUrl, 's20ua2');
    const b = await signup(env.baseUrl, 's20ub2');
    const c = await signup(env.baseUrl, 's20uc2');
    const litUnd = await makeGroup(a, [b, c]); // displayName 에 리터럴 '_' 포함
    const d = await signup(env.baseUrl, 's20ud2');
    const e = await signup(env.baseUrl, 's20ue2');
    const noUnd = await makeGroup(a, [d, e]);

    await request(env.baseUrl)
      .patch(`/me/dms/${litUnd}`)
      .set(bearer(a.accessToken))
      .send({ name: 'team_alpha' });
    await request(env.baseUrl)
      .patch(`/me/dms/${noUnd}`)
      .set(bearer(a.accessToken))
      .send({ name: 'teamXalpha' });

    // '_' 가 escape 되지 않으면 single-char 와일드카드라 'teamXalpha' 도 매칭된다.
    const hit = await request(env.baseUrl)
      .get('/me/dms/groups')
      .query({ q: 'team_alpha' })
      .set(bearer(a.accessToken));
    expect(hit.status).toBe(200);
    const ids = hit.body.items.map((i: { channelId: string }) => i.channelId);
    expect(ids).toContain(litUnd);
    expect(ids).not.toContain(noUnd);
  });

  it('FR-DM-04: q 가 100자를 초과하면 검색을 무시(전체 목록 반환)한다 — DoS 방어', async () => {
    const a = await signup(env.baseUrl, 's20la');
    const b = await signup(env.baseUrl, 's20lb');
    const c = await signup(env.baseUrl, 's20lc');
    const g = await makeGroup(a, [b, c]);
    await request(env.baseUrl)
      .patch(`/me/dms/${g}`)
      .set(bearer(a.accessToken))
      .send({ name: 'Findable' });

    // 101자 검색어 → buildSearchPattern 이 null 반환 → 필터 무시(기존 목록 그대로).
    const res = await request(env.baseUrl)
      .get('/me/dms/groups')
      .query({ q: 'x'.repeat(101) })
      .set(bearer(a.accessToken));
    expect(res.status).toBe(200);
    const ids = res.body.items.map((i: { channelId: string }) => i.channelId);
    // 검색어가 무시되므로(매칭 안 함이 아니라 필터 미적용) 본인 그룹이 그대로 나온다.
    expect(ids).toContain(g);
  });

  // ── FR-DM-06: 아이콘 업로드/삭제 + magic-bytes/타입/크기 ──────────────────
  it('FR-DM-06: 유효 PNG 업로드가 iconUrl 을 세팅하고 dm.group_updated 를 emit 한다', async () => {
    const a = await signup(env.baseUrl, 's20ia');
    const b = await signup(env.baseUrl, 's20ib');
    const c = await signup(env.baseUrl, 's20ic');
    const channelId = await makeGroup(a, [b, c]);

    const received: Array<Record<string, unknown>> = [];
    const handler = (e: Record<string, unknown>): void => {
      received.push(e);
    };
    emitter.on(DM_GROUP_UPDATED, handler);

    const res = await request(env.baseUrl)
      .post(`/me/dms/${channelId}/icon`)
      .set(bearer(a.accessToken))
      .attach('file', PNG_MAGIC, { filename: 'icon.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    expect(typeof res.body.iconUrl).toBe('string');
    const key = res.body.iconUrl as string;

    // MinIO(stub) 에 바이트가 PUT 됐고 DB iconUrl 이 키로 세팅됐다.
    expect(env.s3.putCalls).toContain(key);
    const ch = await env.prisma.channel.findUnique({ where: { id: channelId } });
    expect(ch!.iconUrl).toBe(key);

    await env.dispatcher.drain();
    const ev = received.find((e) => (e as { channelId?: string }).channelId === channelId);
    expect(ev).toBeDefined();
    expect(ev!.iconUrl).toBe(key);
    emitter.off(DM_GROUP_UPDATED, handler);

    // 삭제: MinIO object 정리 + iconUrl=NULL.
    const del = await request(env.baseUrl)
      .delete(`/me/dms/${channelId}/icon`)
      .set(bearer(a.accessToken));
    expect(del.status).toBe(204);
    expect(env.s3.deleteCalls).toContain(key);
    const ch2 = await env.prisma.channel.findUnique({ where: { id: channelId } });
    expect(ch2!.iconUrl).toBeNull();
  });

  it('FR-DM-06: 확장자 위조(GIF 바이트를 PNG mime 로) 는 422 INVALID_MAGIC_BYTES 로 거부한다', async () => {
    const a = await signup(env.baseUrl, 's20fa');
    const b = await signup(env.baseUrl, 's20fb');
    const c = await signup(env.baseUrl, 's20fc');
    const channelId = await makeGroup(a, [b, c]);

    const res = await request(env.baseUrl)
      .post(`/me/dms/${channelId}/icon`)
      .set(bearer(a.accessToken))
      .attach('file', GIF_MAGIC, { filename: 'icon.png', contentType: 'image/png' });
    expect(res.status).toBe(422);
    const ch = await env.prisma.channel.findUnique({ where: { id: channelId } });
    expect(ch!.iconUrl).toBeNull();
  });

  it('FR-DM-06: 허용 안 된 mime(text/plain)은 415 로 거부한다', async () => {
    const a = await signup(env.baseUrl, 's20ma');
    const b = await signup(env.baseUrl, 's20mb');
    const c = await signup(env.baseUrl, 's20mc');
    const channelId = await makeGroup(a, [b, c]);

    const res = await request(env.baseUrl)
      .post(`/me/dms/${channelId}/icon`)
      .set(bearer(a.accessToken))
      .attach('file', Buffer.from('hello'), { filename: 'x.txt', contentType: 'text/plain' });
    expect(res.status).toBe(415);
  });

  it('FR-DM-06: 멤버 아닌 사용자의 아이콘 업로드는 404', async () => {
    const a = await signup(env.baseUrl, 's20oa');
    const b = await signup(env.baseUrl, 's20ob');
    const c = await signup(env.baseUrl, 's20oc');
    const outsider = await signup(env.baseUrl, 's20od');
    const channelId = await makeGroup(a, [b, c]);

    const res = await request(env.baseUrl)
      .post(`/me/dms/${channelId}/icon`)
      .set(bearer(outsider.accessToken))
      .attach('file', PNG_MAGIC, { filename: 'icon.png', contentType: 'image/png' });
    expect(res.status).toBe(404);
  });

  // ── FR-DM-10: 숨기기 목록제외 + 자동복원 ──────────────────────────────────
  it('FR-DM-10: DM 숨기면 목록에서 빠지고, 상대 새 메시지 도착 시 자동 복원된다', async () => {
    const a = await signup(env.baseUrl, 's20ha');
    const b = await signup(env.baseUrl, 's20hb');
    const channelId = await openDm(a, b);
    await sendDm(b, channelId, 'first');

    // a 가 숨긴다 → a 목록에서 제외, b 목록에는 그대로.
    const hide = await request(env.baseUrl)
      .patch(`/me/dms/${channelId}/visibility`)
      .set(bearer(a.accessToken))
      .send({ visibility: 'HIDDEN' });
    expect(hide.status).toBe(200);

    const aListHidden = await request(env.baseUrl).get('/me/dms').set(bearer(a.accessToken));
    expect(aListHidden.body.items.map((i: { channelId: string }) => i.channelId)).not.toContain(
      channelId,
    );
    const bList = await request(env.baseUrl).get('/me/dms').set(bearer(b.accessToken));
    expect(bList.body.items.map((i: { channelId: string }) => i.channelId)).toContain(channelId);

    // 상대(b)의 새 메시지 도착 → a 의 hiddenAt 자동 복원(보낸 본인 b 는 영향 없음).
    await sendDm(b, channelId, 'ping after hide');
    const aListRestored = await request(env.baseUrl).get('/me/dms').set(bearer(a.accessToken));
    expect(aListRestored.body.items.map((i: { channelId: string }) => i.channelId)).toContain(
      channelId,
    );

    // DB 확인: a 의 hiddenAt 은 NULL, visibleFrom 은 자동복원으로 재설정되지 않음.
    const aOverride = await env.prisma.channelPermissionOverride.findFirst({
      where: { channelId, principalType: 'USER', principalId: a.userId },
    });
    expect(aOverride!.hiddenAt).toBeNull();
  });

  it('FR-DM-10: 본인이 보낸 메시지는 본인 숨김을 복원하지 않는다', async () => {
    const a = await signup(env.baseUrl, 's20sa');
    const b = await signup(env.baseUrl, 's20sb');
    const channelId = await openDm(a, b);

    await request(env.baseUrl)
      .patch(`/me/dms/${channelId}/visibility`)
      .set(bearer(a.accessToken))
      .send({ visibility: 'HIDDEN' });

    // a 본인이 메시지를 보냄 — a 의 hiddenAt 은 그대로 유지(자동복원 제외 본인).
    await sendDm(a, channelId, 'self message');
    const aList = await request(env.baseUrl).get('/me/dms').set(bearer(a.accessToken));
    expect(aList.body.items.map((i: { channelId: string }) => i.channelId)).not.toContain(
      channelId,
    );
    const aOverride = await env.prisma.channelPermissionOverride.findFirst({
      where: { channelId, principalType: 'USER', principalId: a.userId },
    });
    expect(aOverride!.hiddenAt).not.toBeNull();
  });

  it('FR-DM-10: VISIBLE 토글로 수동 복원할 수 있다', async () => {
    const a = await signup(env.baseUrl, 's20va');
    const b = await signup(env.baseUrl, 's20vb');
    const channelId = await openDm(a, b);

    await request(env.baseUrl)
      .patch(`/me/dms/${channelId}/visibility`)
      .set(bearer(a.accessToken))
      .send({ visibility: 'HIDDEN' });
    const restore = await request(env.baseUrl)
      .patch(`/me/dms/${channelId}/visibility`)
      .set(bearer(a.accessToken))
      .send({ visibility: 'VISIBLE' });
    expect(restore.status).toBe(200);
    const aList = await request(env.baseUrl).get('/me/dms').set(bearer(a.accessToken));
    expect(aList.body.items.map((i: { channelId: string }) => i.channelId)).toContain(channelId);
  });

  // ── FR-DM-11: 뮤트 upsert + 만료 ──────────────────────────────────────────
  it('FR-DM-11: 무기한 뮤트(upsert)와 만료 필터가 동작한다', async () => {
    const a = await signup(env.baseUrl, 's20ta');
    const b = await signup(env.baseUrl, 's20tb');
    const channelId = await openDm(a, b);

    // null = 무기한.
    const m1 = await request(env.baseUrl)
      .patch(`/me/dms/${channelId}/mute`)
      .set(bearer(a.accessToken))
      .send({ mutedUntil: null });
    expect(m1.status).toBe(200);
    expect(m1.body.mutedUntil).toBeNull();

    let mutes = await request(env.baseUrl).get('/me/mutes').set(bearer(a.accessToken));
    expect(mutes.body.items.map((i: { channelId: string }) => i.channelId)).toContain(channelId);

    // 같은 채널 재요청 = upsert(행 1개 유지) — 미래 시각으로 갱신.
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const m2 = await request(env.baseUrl)
      .patch(`/me/dms/${channelId}/mute`)
      .set(bearer(a.accessToken))
      .send({ mutedUntil: future });
    expect(m2.status).toBe(200);
    expect(m2.body.mutedUntil).toBe(new Date(future).toISOString());
    const rows = await env.prisma.userChannelMute.findMany({
      where: { userId: a.userId, channelId },
    });
    expect(rows).toHaveLength(1); // upsert — 중복 행 없음.

    // 과거 시각으로 갱신 → listActiveMutes 의 query-time 필터가 제외.
    const past = new Date(Date.now() - 3_600_000).toISOString();
    await request(env.baseUrl)
      .patch(`/me/dms/${channelId}/mute`)
      .set(bearer(a.accessToken))
      .send({ mutedUntil: past });
    mutes = await request(env.baseUrl).get('/me/mutes').set(bearer(a.accessToken));
    expect(mutes.body.items.map((i: { channelId: string }) => i.channelId)).not.toContain(
      channelId,
    );
  });

  it('FR-DM-11: 잘못된 mutedUntil(비-ISO8601)은 400 으로 거부한다', async () => {
    const a = await signup(env.baseUrl, 's20za');
    const b = await signup(env.baseUrl, 's20zb');
    const channelId = await openDm(a, b);
    const res = await request(env.baseUrl)
      .patch(`/me/dms/${channelId}/mute`)
      .set(bearer(a.accessToken))
      .send({ mutedUntil: 'not-a-date' });
    expect(res.status).toBe(400);
  });

  // ── FR-DM-11 (BLOCKER fix-forward, IDOR): 멤버십 게이트 ────────────────────
  it('FR-DM-11: 비멤버의 mute 는 404 이고 UserChannelMute 행이 생성되지 않는다 (IDOR)', async () => {
    const a = await signup(env.baseUrl, 's20ima');
    const b = await signup(env.baseUrl, 's20imb');
    const outsider = await signup(env.baseUrl, 's20imc');
    const channelId = await openDm(a, b);

    // outsider 는 이 DM 의 멤버가 아님 — 404(존재 leak 방지), 행 미생성.
    const res = await request(env.baseUrl)
      .patch(`/me/dms/${channelId}/mute`)
      .set(bearer(outsider.accessToken))
      .send({ mutedUntil: null });
    expect(res.status).toBe(404);

    const rows = await env.prisma.userChannelMute.findMany({
      where: { userId: outsider.userId, channelId },
    });
    expect(rows).toHaveLength(0);
  });

  it('FR-DM-11: 존재하지 않는 채널의 mute 는 404 이다 (열거 방지, P2003 우회)', async () => {
    const a = await signup(env.baseUrl, 's20ena');
    // 무작위 UUID — 실존하지 않는 채널. FK 위반(P2003) 500 이 아니라 404 여야 한다.
    const ghost = '00000000-0000-4000-8000-000000000000';
    const res = await request(env.baseUrl)
      .patch(`/me/dms/${ghost}/mute`)
      .set(bearer(a.accessToken))
      .send({ mutedUntil: null });
    expect(res.status).toBe(404);
  });
});
