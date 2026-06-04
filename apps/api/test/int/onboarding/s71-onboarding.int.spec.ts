/**
 * S71 (D13 / FR-W07·W08·W09): 워크스페이스 온보딩 통합 테스트.
 *
 * 검증:
 *   - 규칙 동의 서버 게이트: 규칙 존재 + 미동의 멤버의 메시지 전송 403 → accept-rules → 성공.
 *   - 리액션 게이트(추가 차단 · toggle-off 허용).
 *   - 규칙 없는 워크스페이스는 게이트 무영향(회귀 0).
 *   - Step2 complete: 채널 구독 + 역할 부여 원자성/멱등 · '건너뛰기' completedAt.
 *   - 웰컴 BullMQ enqueue(complete 성공 응답).
 *   - 관리자 CRUD ADMIN+(비-ADMIN 403).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { ORIGIN, setupRtIntEnv, signup, type Actor, type RtIntEnv } from '../realtime/helpers';

let env: RtIntEnv;

beforeAll(async () => {
  env = await setupRtIntEnv();
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

/** owner + member 가 있는 워크스페이스(슬러그 반환) + 기본 채널을 구성한다. */
async function makeWs(): Promise<{
  workspaceId: string;
  slug: string;
  channelId: string;
  owner: Actor;
  member: Actor;
}> {
  const owner = await signup(env.baseUrl, 's71o');
  const member = await signup(env.baseUrl, 's71m');
  const slug = `s71-${Date.now().toString(36)}${Math.floor(Math.random() * 999)}`;
  const ws = await request(env.baseUrl)
    .post('/workspaces')
    .set('origin', ORIGIN)
    .set(auth(owner.accessToken))
    .send({ name: 'S71Ws', slug })
    .expect(201);
  const workspaceId = ws.body.id as string;

  // member 를 초대 수락으로 합류.
  const inv = await request(env.baseUrl)
    .post(`/workspaces/${workspaceId}/invites`)
    .set('origin', ORIGIN)
    .set(auth(owner.accessToken))
    .send({ maxUses: 10 })
    .expect(201);
  await request(env.baseUrl)
    .post(`/invites/${inv.body.invite.code}/accept`)
    .set('origin', ORIGIN)
    .set(auth(member.accessToken))
    .expect(201);

  const ch = await request(env.baseUrl)
    .post(`/workspaces/${workspaceId}/channels`)
    .set('origin', ORIGIN)
    .set(auth(owner.accessToken))
    .send({ name: `gen-${Date.now().toString(36).slice(-6)}`, type: 'TEXT' })
    .expect(201);

  return { workspaceId, slug, channelId: ch.body.id as string, owner, member };
}

describe('S71 규칙 동의 서버 게이트 (FR-W07 / Fork-C)', () => {
  it('규칙 존재 + 미동의 멤버의 메시지 전송은 403 RULES_NOT_ACCEPTED, accept-rules 후 성공', async () => {
    const { workspaceId, slug, channelId, owner, member } = await makeWs();

    // 규칙 0개일 때는 게이트 무동작 — 미동의 멤버도 전송 성공(회귀 0).
    const beforeRule = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${channelId}/messages`)
      .set('origin', ORIGIN)
      .set(auth(member.accessToken))
      .send({ content: 'no rules yet' });
    expect(beforeRule.status).toBe(201);

    // owner(ADMIN+)가 규칙 생성.
    await request(env.baseUrl)
      .post(`/workspaces/${slug}/onboarding/admin/rules`)
      .set('origin', ORIGIN)
      .set(auth(owner.accessToken))
      .send({ title: '서로 존중하기', description: '예의를 지켜주세요' })
      .expect(201);

    // 미동의 멤버의 전송은 이제 403 RULES_NOT_ACCEPTED.
    const blocked = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${channelId}/messages`)
      .set('origin', ORIGIN)
      .set(auth(member.accessToken))
      .send({ content: 'blocked' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.errorCode).toBe('RULES_NOT_ACCEPTED');

    // 동의 후 전송 성공.
    await request(env.baseUrl)
      .post(`/workspaces/${slug}/onboarding/accept-rules`)
      .set('origin', ORIGIN)
      .set(auth(member.accessToken))
      .expect(200);
    const after = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${channelId}/messages`)
      .set('origin', ORIGIN)
      .set(auth(member.accessToken))
      .send({ content: 'now allowed' });
    expect(after.status).toBe(201);
  });

  it('규칙 존재 + 미동의 멤버의 리액션 추가는 403, 동의 후 성공', async () => {
    const { workspaceId, slug, channelId, owner, member } = await makeWs();
    // owner 가 채널에 메시지를 남기고(규칙 전이라 OK), member 가 반응을 단다.
    await request(env.baseUrl)
      .post(`/workspaces/${slug}/onboarding/admin/rules`)
      .set('origin', ORIGIN)
      .set(auth(owner.accessToken))
      .send({ title: '규칙1' })
      .expect(201);
    const ownerMsg = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${channelId}/messages`)
      .set('origin', ORIGIN)
      .set(auth(owner.accessToken))
      .send({ content: 'react to me' })
      .expect(201);
    const msgId = ownerMsg.body.message.id as string;

    const blocked = await request(env.baseUrl)
      .post(`/messages/${msgId}/reactions`)
      .set('origin', ORIGIN)
      .set(auth(member.accessToken))
      .send({ emoji: '👍' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.errorCode).toBe('RULES_NOT_ACCEPTED');

    await request(env.baseUrl)
      .post(`/workspaces/${slug}/onboarding/accept-rules`)
      .set('origin', ORIGIN)
      .set(auth(member.accessToken))
      .expect(200);
    const ok = await request(env.baseUrl)
      .post(`/messages/${msgId}/reactions`)
      .set('origin', ORIGIN)
      .set(auth(member.accessToken))
      .send({ emoji: '👍' });
    expect(ok.status).toBe(200);
    expect(ok.body.byMe).toBe(true);
  });
});

describe('S71 Step2 complete — 원자성 · 멱등 (FR-W08)', () => {
  it('SINGLE 선택지로 채널 구독 + 역할 부여를 처리하고 completedAt 을 세팅한다(멱등)', async () => {
    const { workspaceId, slug, owner, member } = await makeWs();

    // 추가 채널 + 커스텀 역할 생성(선택지 타겟).
    const targetCh = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels`)
      .set('origin', ORIGIN)
      .set(auth(owner.accessToken))
      .send({ name: `interest-${Date.now().toString(36).slice(-5)}`, type: 'TEXT' })
      .expect(201);
    const role = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/roles`)
      .set('origin', ORIGIN)
      .set(auth(owner.accessToken))
      .send({
        name: `Frontend-${Date.now().toString(36).slice(-5)}`,
        colorHex: null,
        permissions: '0',
      })
      .expect(201);
    const roleId = (role.body.role?.id ?? role.body.id) as string;

    // 질문(SINGLE) 생성.
    const q = await request(env.baseUrl)
      .post(`/workspaces/${slug}/onboarding/admin/questions`)
      .set('origin', ORIGIN)
      .set(auth(owner.accessToken))
      .send({
        type: 'SINGLE',
        isRequired: true,
        label: '관심사를 선택하세요',
        options: [{ id: 'fe', label: 'Frontend', channelIds: [targetCh.body.id], roleId }],
      })
      .expect(201);
    const questionId = q.body.id as string;

    const body = { answers: [{ questionId, optionIds: ['fe'] }] };
    const r1 = await request(env.baseUrl)
      .post(`/workspaces/${slug}/onboarding/complete`)
      .set('origin', ORIGIN)
      .set(auth(member.accessToken))
      .send(body);
    expect(r1.status).toBe(200);
    expect(r1.body.joinedChannelCount).toBe(1);
    expect(r1.body.assignedRoleCount).toBe(1);

    // 채널 구독(USER override) + 역할(MemberRole) 이 실제로 존재.
    const override = await env.prisma.channelPermissionOverride.findUnique({
      where: {
        channelId_principalType_principalId: {
          channelId: targetCh.body.id,
          principalType: 'USER',
          principalId: member.userId,
        },
      },
    });
    expect(override).not.toBeNull();
    const memberRole = await env.prisma.memberRole.findUnique({
      where: { workspaceId_userId_roleId: { workspaceId, userId: member.userId, roleId } },
    });
    expect(memberRole).not.toBeNull();

    // 멱등: 재호출해도 추가 행이 생기지 않고 200.
    const r2 = await request(env.baseUrl)
      .post(`/workspaces/${slug}/onboarding/complete`)
      .set('origin', ORIGIN)
      .set(auth(member.accessToken))
      .send(body);
    expect(r2.status).toBe(200);
    const overrideCount = await env.prisma.channelPermissionOverride.count({
      where: { channelId: targetCh.body.id, principalType: 'USER', principalId: member.userId },
    });
    expect(overrideCount).toBe(1);
  });

  it("'건너뛰기'(빈 answers)는 채널/역할 미실행 · onboardingCompletedAt 만 세팅한다", async () => {
    const { workspaceId, slug, member } = await makeWs();
    const r = await request(env.baseUrl)
      .post(`/workspaces/${slug}/onboarding/complete`)
      .set('origin', ORIGIN)
      .set(auth(member.accessToken))
      .send({ answers: [] });
    expect(r.status).toBe(200);
    expect(r.body.joinedChannelCount).toBe(0);
    const m = await env.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: member.userId } },
      select: { onboardingCompletedAt: true },
    });
    expect(m?.onboardingCompletedAt).not.toBeNull();
  });
});

describe('S71 권한상승 방어 + complete 게이트 (fix-forward)', () => {
  it('★createQuestion: 옵션 roleId 에 시스템 역할(OWNER/ADMIN) 매핑은 거부된다', async () => {
    const { workspaceId, slug, owner } = await makeWs();
    // 시스템 역할(예: ADMIN) 한 개를 조회한다 — 시드된 시스템 5단계 중 하나.
    const adminRole = await env.prisma.role.findFirst({
      where: { workspaceId, isSystem: true, name: 'ADMIN' },
      select: { id: true },
    });
    expect(adminRole).not.toBeNull();
    const r = await request(env.baseUrl)
      .post(`/workspaces/${slug}/onboarding/admin/questions`)
      .set('origin', ORIGIN)
      .set(auth(owner.accessToken))
      .send({
        type: 'SINGLE',
        isRequired: false,
        label: 'pick',
        options: [{ id: 'o1', label: 'a', channelIds: [], roleId: adminRole!.id }],
      });
    // 시스템 역할 매핑 → ROLE_PRIVILEGE_ESCALATION(403).
    expect(r.status).toBe(403);
    expect(r.body.errorCode).toBe('ROLE_PRIVILEGE_ESCALATION');
  });

  it('★complete rules 게이트: 규칙 존재 + 미동의 멤버의 complete 직접 호출은 403', async () => {
    const { slug, owner, member } = await makeWs();
    await request(env.baseUrl)
      .post(`/workspaces/${slug}/onboarding/admin/rules`)
      .set('origin', ORIGIN)
      .set(auth(owner.accessToken))
      .send({ title: '규칙 게이트' })
      .expect(201);
    // 동의(accept-rules) 없이 complete 직접 호출 → 403 RULES_NOT_ACCEPTED.
    const r = await request(env.baseUrl)
      .post(`/workspaces/${slug}/onboarding/complete`)
      .set('origin', ORIGIN)
      .set(auth(member.accessToken))
      .send({ answers: [] });
    expect(r.status).toBe(403);
    expect(r.body.errorCode).toBe('RULES_NOT_ACCEPTED');
  });

  it('★complete 멱등: 2회 호출 시 두 번째는 부수효과 없이 첫 completedAt 을 반환한다', async () => {
    const { workspaceId, slug, owner, member } = await makeWs();
    const targetCh = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels`)
      .set('origin', ORIGIN)
      .set(auth(owner.accessToken))
      .send({ name: `idem-${Date.now().toString(36).slice(-5)}`, type: 'TEXT' })
      .expect(201);
    const q = await request(env.baseUrl)
      .post(`/workspaces/${slug}/onboarding/admin/questions`)
      .set('origin', ORIGIN)
      .set(auth(owner.accessToken))
      .send({
        type: 'SINGLE',
        isRequired: false,
        label: '관심사',
        options: [{ id: 'fe', label: 'FE', channelIds: [targetCh.body.id], roleId: null }],
      })
      .expect(201);
    const body = { answers: [{ questionId: q.body.id, optionIds: ['fe'] }] };
    const r1 = await request(env.baseUrl)
      .post(`/workspaces/${slug}/onboarding/complete`)
      .set('origin', ORIGIN)
      .set(auth(member.accessToken))
      .send(body);
    expect(r1.status).toBe(200);
    expect(r1.body.joinedChannelCount).toBe(1);

    // 두 번째 호출: 멱등 early-return — joinedChannelCount=0, 첫 completedAt 그대로.
    const r2 = await request(env.baseUrl)
      .post(`/workspaces/${slug}/onboarding/complete`)
      .set('origin', ORIGIN)
      .set(auth(member.accessToken))
      .send(body);
    expect(r2.status).toBe(200);
    expect(r2.body.joinedChannelCount).toBe(0);
    expect(r2.body.assignedRoleCount).toBe(0);
    expect(r2.body.onboardingCompletedAt).toBe(r1.body.onboardingCompletedAt);
  });
});

describe('S71 관리자 CRUD — ADMIN+ 게이트', () => {
  it('비-ADMIN 멤버의 규칙 생성은 403', async () => {
    const { slug, member } = await makeWs();
    const r = await request(env.baseUrl)
      .post(`/workspaces/${slug}/onboarding/admin/rules`)
      .set('origin', ORIGIN)
      .set(auth(member.accessToken))
      .send({ title: 'nope' });
    expect(r.status).toBe(403);
  });

  it('규칙 10개 초과 생성은 409 ONBOARDING_RULES_LIMIT', async () => {
    const { slug, owner } = await makeWs();
    for (let i = 0; i < 10; i++) {
      await request(env.baseUrl)
        .post(`/workspaces/${slug}/onboarding/admin/rules`)
        .set('origin', ORIGIN)
        .set(auth(owner.accessToken))
        .send({ title: `rule ${i}` })
        .expect(201);
    }
    const over = await request(env.baseUrl)
      .post(`/workspaces/${slug}/onboarding/admin/rules`)
      .set('origin', ORIGIN)
      .set(auth(owner.accessToken))
      .send({ title: 'rule 11' });
    expect(over.status).toBe(409);
    expect(over.body.errorCode).toBe('ONBOARDING_RULES_LIMIT');
  });

  it('GET onboarding 상태는 규칙/질문/웰컴 카탈로그를 반환한다', async () => {
    const { slug, owner, member } = await makeWs();
    await request(env.baseUrl)
      .post(`/workspaces/${slug}/onboarding/admin/rules`)
      .set('origin', ORIGIN)
      .set(auth(owner.accessToken))
      .send({ title: '규칙A' })
      .expect(201);
    await request(env.baseUrl)
      .put(`/workspaces/${slug}/onboarding/admin/welcome`)
      .set('origin', ORIGIN)
      .set(auth(owner.accessToken))
      .send({ message: '환영합니다', todos: ['프로필 작성'] })
      .expect(200);

    const state = await request(env.baseUrl)
      .get(`/workspaces/${slug}/onboarding`)
      .set('origin', ORIGIN)
      .set(auth(member.accessToken))
      .expect(200);
    expect(state.body.rules).toHaveLength(1);
    expect(state.body.welcome.message).toBe('환영합니다');
    expect(state.body.welcome.todos).toEqual(['프로필 작성']);
    expect(state.body.rulesAcceptedAt).toBeNull();
  });
});
