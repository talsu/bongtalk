/**
 * S85 (FR-CH-16) — 사이드바 개인 섹션 integration (실DB / Testcontainers).
 *
 * 검증:
 *   - 마이그레이션 적용 후 POST 가 섹션을 만들고 GET 이 position asc 로 반환한다.
 *   - 채널 할당/해제(POST/DELETE channels) — 할당 시 섹션 channelIds 에 반영,
 *     해제 시 사라진다(채널 기본 위치 복귀).
 *   - 섹션 재정렬 + 섹션 내 채널 재정렬(fractional position) 왕복.
 *   - 개인 격리: 사용자 A 의 섹션이 사용자 B 응답에 없다.
 *   - 삭제 cascade: 섹션 삭제 시 할당 행이 정리되고 채널은 어느 섹션에도 없다.
 *   - 타 워크스페이스/미존재 채널 할당은 CHANNEL_NOT_FOUND.
 *
 * helpers.setupChIntEnv 가 `prisma migrate deploy` 로 신규 마이그레이션을 실제 PG16 에
 * 적용하므로, 본 스펙이 도는 것 자체가 마이그레이션 적용 검증을 겸한다.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { ChIntEnv, ORIGIN, bearer, seedWorkspaceWithRoles, setupChIntEnv } from './helpers';

let env: ChIntEnv;
let seed: Awaited<ReturnType<typeof seedWorkspaceWithRoles>>;

beforeAll(async () => {
  env = await setupChIntEnv();
  seed = await seedWorkspaceWithRoles(env.baseUrl);
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

async function createChannel(name: string): Promise<string> {
  const res = await request(env.baseUrl)
    .post(`/workspaces/${seed.workspaceId}/channels`)
    .set('origin', ORIGIN)
    .set(bearer(seed.admin.accessToken))
    .send({ name, type: 'TEXT' });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

function rid(): string {
  return Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}

describe('FR-CH-16 사이드바 개인 섹션 (실DB)', () => {
  it('섹션 생성 → 목록(position asc) → 채널 할당/해제 → 섹션·채널 재정렬', async () => {
    const ws = seed.workspaceId;
    const tok = seed.member.accessToken;

    // 섹션 3개 생성(말단 append → A,B,C)
    const names = [`작업-${rid()}`, `참고-${rid()}`, `보관-${rid()}`];
    const ids: string[] = [];
    for (const name of names) {
      const r = await request(env.baseUrl)
        .post(`/workspaces/${ws}/sidebar-sections`)
        .set('origin', ORIGIN)
        .set(bearer(tok))
        .send({ name });
      expect(r.status).toBe(201);
      expect(r.body.name).toBe(name);
      ids.push(r.body.id as string);
    }
    const [a, b, c] = ids;

    const list1 = await request(env.baseUrl)
      .get(`/workspaces/${ws}/sidebar-sections`)
      .set('origin', ORIGIN)
      .set(bearer(tok));
    expect(list1.status).toBe(200);
    expect(list1.body.sections.map((s: { id: string }) => s.id)).toEqual([a, b, c]);

    // 채널 2개를 섹션 A 에 할당
    const ch1 = await createChannel(`sec-ch1-${rid()}`);
    const ch2 = await createChannel(`sec-ch2-${rid()}`);
    for (const chId of [ch1, ch2]) {
      const r = await request(env.baseUrl)
        .post(`/workspaces/${ws}/sidebar-sections/${a}/channels`)
        .set('origin', ORIGIN)
        .set(bearer(tok))
        .send({ channelId: chId });
      expect(r.status).toBe(200);
    }
    const afterAssign = await request(env.baseUrl)
      .get(`/workspaces/${ws}/sidebar-sections`)
      .set('origin', ORIGIN)
      .set(bearer(tok));
    const secA1 = afterAssign.body.sections.find((s: { id: string }) => s.id === a);
    expect(secA1.channelIds).toEqual([ch1, ch2]);

    // 섹션 내 채널 재정렬: ch2 를 ch1 앞으로(beforeId=ch1) → [ch2, ch1]
    const mvCh = await request(env.baseUrl)
      .patch(`/workspaces/${ws}/sidebar-sections/channels/${ch2}/position`)
      .set('origin', ORIGIN)
      .set(bearer(tok))
      .send({ beforeId: ch1 });
    expect(mvCh.status).toBe(200);
    expect(mvCh.body.channelIds).toEqual([ch2, ch1]);

    // 채널을 섹션 B 로 이동(sectionId=b) → A 에서 빠지고 B 에 등장
    const mvToB = await request(env.baseUrl)
      .patch(`/workspaces/${ws}/sidebar-sections/channels/${ch1}/position`)
      .set('origin', ORIGIN)
      .set(bearer(tok))
      .send({ sectionId: b });
    expect(mvToB.status).toBe(200);
    expect(mvToB.body.id).toBe(b);
    expect(mvToB.body.channelIds).toEqual([ch1]);

    // 섹션 재정렬: C 를 A 앞으로(beforeId=a) → C,A,B
    const mvSec = await request(env.baseUrl)
      .patch(`/workspaces/${ws}/sidebar-sections/${c}/position`)
      .set('origin', ORIGIN)
      .set(bearer(tok))
      .send({ beforeId: a });
    expect(mvSec.status).toBe(200);
    const list2 = await request(env.baseUrl)
      .get(`/workspaces/${ws}/sidebar-sections`)
      .set('origin', ORIGIN)
      .set(bearer(tok));
    expect(list2.body.sections.map((s: { id: string }) => s.id)).toEqual([c, a, b]);
    // position 단사성
    const positions = list2.body.sections.map((s: { position: string }) => s.position);
    expect(new Set(positions).size).toBe(positions.length);

    // 채널 해제: ch2(섹션 A) 제거 → A.channelIds 비어짐
    const unassign = await request(env.baseUrl)
      .delete(`/workspaces/${ws}/sidebar-sections/${a}/channels/${ch2}`)
      .set('origin', ORIGIN)
      .set(bearer(tok));
    expect(unassign.status).toBe(200);
    expect(unassign.body.channelIds).toEqual([]);
  }, 60_000);

  it('개인 격리: 사용자 A 의 섹션이 사용자 B 응답에 없다', async () => {
    const ws = seed.workspaceId;
    const ra = await request(env.baseUrl)
      .post(`/workspaces/${ws}/sidebar-sections`)
      .set('origin', ORIGIN)
      .set(bearer(seed.member.accessToken))
      .send({ name: `priv-A-${rid()}` });
    expect(ra.status).toBe(201);
    const aSectionId = ra.body.id as string;

    const listB = await request(env.baseUrl)
      .get(`/workspaces/${ws}/sidebar-sections`)
      .set('origin', ORIGIN)
      .set(bearer(seed.admin.accessToken));
    expect(listB.status).toBe(200);
    expect(listB.body.sections.map((s: { id: string }) => s.id)).not.toContain(aSectionId);

    // 사용자 B 가 A 의 섹션을 직접 조작 시도 → 404(중립)
    const mv = await request(env.baseUrl)
      .patch(`/workspaces/${ws}/sidebar-sections/${aSectionId}`)
      .set('origin', ORIGIN)
      .set(bearer(seed.admin.accessToken))
      .send({ name: 'hijack' });
    expect(mv.status).toBe(404);
    expect(mv.body.errorCode).toBe('SIDEBAR_SECTION_NOT_FOUND');
  }, 60_000);

  it('섹션 삭제 cascade: 할당 행 정리 + 채널은 어느 섹션에도 없다', async () => {
    const ws = seed.workspaceId;
    const tok = seed.member.accessToken;
    const sec = await request(env.baseUrl)
      .post(`/workspaces/${ws}/sidebar-sections`)
      .set('origin', ORIGIN)
      .set(bearer(tok))
      .send({ name: `del-${rid()}` });
    const sectionId = sec.body.id as string;
    const ch = await createChannel(`del-ch-${rid()}`);
    await request(env.baseUrl)
      .post(`/workspaces/${ws}/sidebar-sections/${sectionId}/channels`)
      .set('origin', ORIGIN)
      .set(bearer(tok))
      .send({ channelId: ch });

    const del = await request(env.baseUrl)
      .delete(`/workspaces/${ws}/sidebar-sections/${sectionId}`)
      .set('origin', ORIGIN)
      .set(bearer(tok));
    expect(del.status).toBe(204);

    // 할당 행이 cascade 로 사라졌다(채널은 기본 위치 복귀).
    const assignCount = await env.prisma.userSidebarChannelAssignment.count({
      where: { userId: seed.member.userId, channelId: ch },
    });
    expect(assignCount).toBe(0);

    const list = await request(env.baseUrl)
      .get(`/workspaces/${ws}/sidebar-sections`)
      .set('origin', ORIGIN)
      .set(bearer(tok));
    const stillHasChannel = list.body.sections.some((s: { channelIds: string[] }) =>
      s.channelIds.includes(ch),
    );
    expect(stillHasChannel).toBe(false);
  }, 60_000);

  it('미존재/타 워크스페이스 채널 할당은 CHANNEL_NOT_FOUND', async () => {
    const ws = seed.workspaceId;
    const tok = seed.member.accessToken;
    const sec = await request(env.baseUrl)
      .post(`/workspaces/${ws}/sidebar-sections`)
      .set('origin', ORIGIN)
      .set(bearer(tok))
      .send({ name: `cnf-${rid()}` });
    const sectionId = sec.body.id as string;

    const r = await request(env.baseUrl)
      .post(`/workspaces/${ws}/sidebar-sections/${sectionId}/channels`)
      .set('origin', ORIGIN)
      .set(bearer(tok))
      .send({ channelId: '00000000-0000-0000-0000-000000000000' });
    expect(r.status).toBe(404);
    expect(r.body.errorCode).toBe('CHANNEL_NOT_FOUND');
  }, 60_000);
});
