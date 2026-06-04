import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  bearer,
  connectReady,
  ORIGIN,
  setupRtIntEnv,
  signup,
  waitForEvent,
  type Actor,
  type RtIntEnv,
} from '../realtime/helpers';

/**
 * S70 (D13 / FR-W06·W06a·W12): 가입 신청(APPLY) 플로우 + 임시멤버 disconnect debounce 강퇴.
 *
 * Testcontainers(PG16 + Redis7) 위에서 실제 HTTP + WS + BullMQ worker(in-process)로 검증한다.
 * temp-evict 워커는 drainDelay=1s 라 2초 debounce 가 ~2.x초 후 발화한다 → 단언 타임아웃은 넉넉히.
 */

let env: RtIntEnv;

beforeAll(async () => {
  env = await setupRtIntEnv();
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

async function makeApplyWorkspace(owner: Actor): Promise<{ workspaceId: string; slug: string }> {
  const slug = `apply-${Date.now().toString(36)}${Math.floor(Math.random() * 999)}`;
  const ws = await request(env.baseUrl)
    .post('/workspaces')
    .set('origin', ORIGIN)
    .set(bearer(owner.accessToken))
    .send({ name: 'ApplyWs', slug, joinMode: 'APPLY' });
  if (ws.status !== 201) throw new Error(`apply ws: ${ws.status} ${ws.text}`);
  return { workspaceId: ws.body.id as string, slug };
}

describe('S70 application submit/process flow', () => {
  let owner: Actor;
  let workspaceId: string;
  let slug: string;

  beforeAll(async () => {
    owner = await signup(env.baseUrl, 's70o');
    const ws = await makeApplyWorkspace(owner);
    workspaceId = ws.workspaceId;
    slug = ws.slug;
  });

  it('APPLY 신청 → PENDING → approve 시 WorkspaceMember 가 생성된다', async () => {
    const applicant = await signup(env.baseUrl, 's70a');
    const submit = await request(env.baseUrl)
      .post(`/workspaces/${slug}/applications`)
      .set('origin', ORIGIN)
      .set(bearer(applicant.accessToken))
      .send({ answers: [{ questionId: 'q1', answer: 'hello' }] });
    expect(submit.status).toBe(201);
    expect(submit.body.status).toBe('PENDING');
    const applicationId = submit.body.id as string;

    // me 폴링: PENDING 상태 확인.
    const me = await request(env.baseUrl)
      .get(`/workspaces/${slug}/applications/me`)
      .set('origin', ORIGIN)
      .set(bearer(applicant.accessToken));
    expect(me.status).toBe(200);
    expect(me.body.application.status).toBe('PENDING');

    // approve(owner).
    const approve = await request(env.baseUrl)
      .patch(`/workspaces/${slug}/applications/${applicationId}`)
      .set('origin', ORIGIN)
      .set(bearer(owner.accessToken))
      .send({ action: 'approve' });
    expect(approve.status).toBe(200);
    expect(approve.body.status).toBe('APPROVED');

    // WorkspaceMember 생성 확인.
    const member = await env.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: applicant.userId } },
    });
    expect(member).not.toBeNull();
  });

  it('PENDING 중복 신청은 409(APPLICATION_PENDING_EXISTS)', async () => {
    const applicant = await signup(env.baseUrl, 's70d');
    await request(env.baseUrl)
      .post(`/workspaces/${slug}/applications`)
      .set('origin', ORIGIN)
      .set(bearer(applicant.accessToken))
      .send({ answers: [] })
      .expect(201);
    const dup = await request(env.baseUrl)
      .post(`/workspaces/${slug}/applications`)
      .set('origin', ORIGIN)
      .set(bearer(applicant.accessToken))
      .send({ answers: [] });
    expect(dup.status).toBe(409);
    expect(dup.body.errorCode).toBe('APPLICATION_PENDING_EXISTS');
  });

  it('WITHDRAWN 후 재신청이 허용되어 다시 PENDING 이 된다', async () => {
    const applicant = await signup(env.baseUrl, 's70w');
    const first = await request(env.baseUrl)
      .post(`/workspaces/${slug}/applications`)
      .set('origin', ORIGIN)
      .set(bearer(applicant.accessToken))
      .send({ answers: [] });
    const appId = first.body.id as string;
    // 취소(PENDING → WITHDRAWN).
    const withdraw = await request(env.baseUrl)
      .delete(`/workspaces/${slug}/applications/${appId}`)
      .set('origin', ORIGIN)
      .set(bearer(applicant.accessToken));
    expect(withdraw.status).toBe(200);
    expect(withdraw.body.status).toBe('WITHDRAWN');
    // 재신청 → 다시 PENDING.
    const reapply = await request(env.baseUrl)
      .post(`/workspaces/${slug}/applications`)
      .set('origin', ORIGIN)
      .set(bearer(applicant.accessToken))
      .send({ answers: [] });
    expect(reapply.status).toBe(201);
    expect(reapply.body.status).toBe('PENDING');
  });

  it('reject 시 reviewNote 가 기록되고 신청자에게 ws:application_reviewed(rejected) 가 도달한다', async () => {
    const applicant = await signup(env.baseUrl, 's70r');
    const submit = await request(env.baseUrl)
      .post(`/workspaces/${slug}/applications`)
      .set('origin', ORIGIN)
      .set(bearer(applicant.accessToken))
      .send({ answers: [] });
    const appId = submit.body.id as string;

    // 신청자 소켓 연결(승인 전 비멤버지만 본인 user 룸은 보유).
    const sock = await connectReady(env.wsUrl, applicant.accessToken);
    const reviewedP = waitForEvent<{ status: string; reviewNote: string | null }>(
      sock,
      'ws:application_reviewed',
      8000,
    );

    const reject = await request(env.baseUrl)
      .patch(`/workspaces/${slug}/applications/${appId}`)
      .set('origin', ORIGIN)
      .set(bearer(owner.accessToken))
      .send({ action: 'reject', reviewNote: '추가 정보가 필요합니다' });
    expect(reject.status).toBe(200);
    expect(reject.body.reviewNote).toBe('추가 정보가 필요합니다');

    await env.dispatcher.drain();
    const reviewed = await reviewedP;
    expect(reviewed.status).toBe('rejected');
    expect(reviewed.reviewNote).toBe('추가 정보가 필요합니다');
    sock.disconnect();
  });

  it('interview 전환 시 interviewChannelId(1:1 DM)가 생성된다', async () => {
    const applicant = await signup(env.baseUrl, 's70i');
    const submit = await request(env.baseUrl)
      .post(`/workspaces/${slug}/applications`)
      .set('origin', ORIGIN)
      .set(bearer(applicant.accessToken))
      .send({ answers: [] });
    const appId = submit.body.id as string;

    const interview = await request(env.baseUrl)
      .patch(`/workspaces/${slug}/applications/${appId}`)
      .set('origin', ORIGIN)
      .set(bearer(owner.accessToken))
      .send({ action: 'interview' });
    expect(interview.status).toBe(200);
    expect(interview.body.status).toBe('INTERVIEW');
    expect(interview.body.interviewChannelId).toBeTruthy();

    // DM 채널이 실제로 생성됐는지 확인(workspace-scoped DIRECT).
    const ch = await env.prisma.channel.findUnique({
      where: { id: interview.body.interviewChannelId as string },
      select: { type: true, workspaceId: true },
    });
    expect(ch?.type).toBe('DIRECT');
    expect(ch?.workspaceId).toBe(workspaceId);
  });
});

describe('S70 temporary member disconnect debounce eviction', () => {
  let owner: Actor;
  let workspaceId: string;

  beforeAll(async () => {
    owner = await signup(env.baseUrl, 's70to');
    const ws = await request(env.baseUrl)
      .post('/workspaces')
      .set('origin', ORIGIN)
      .set(bearer(owner.accessToken))
      .send({ name: 'TempWs', slug: `temp-${Date.now().toString(36)}` });
    workspaceId = ws.body.id as string;
  });

  /** 임시(temporary=true) 초대로 가입한 멤버를 만든다. */
  async function makeTemporaryMember(prefix: string): Promise<Actor> {
    const inv = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/invites`)
      .set('origin', ORIGIN)
      .set(bearer(owner.accessToken))
      .send({ maxUses: 10, temporary: true });
    const code = inv.body.invite.code as string;
    const actor = await signup(env.baseUrl, prefix);
    const accept = await request(env.baseUrl)
      .post(`/invites/${code}/accept`)
      .set('origin', ORIGIN)
      .set(bearer(actor.accessToken));
    expect(accept.status).toBeLessThan(400);
    const m = await env.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: actor.userId } },
      select: { isTemporary: true },
    });
    expect(m?.isTemporary).toBe(true);
    return actor;
  }

  async function isMember(userId: string): Promise<boolean> {
    const m = await env.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { userId: true },
    });
    return m !== null;
  }

  it('임시멤버 마지막 소켓 disconnect → 2초 debounce 후 강퇴된다', async () => {
    const temp = await makeTemporaryMember('s70t1');
    const sock = await connectReady(env.wsUrl, temp.accessToken);
    sock.disconnect();
    // debounce(2s) + drainDelay(1s) + tx/outbox → 넉넉히 5s 대기.
    await new Promise((r) => setTimeout(r, 5000));
    expect(await isMember(temp.userId)).toBe(false);
  }, 20_000);

  it('2초 내 재연결 시 강퇴되지 않는다(debounce 취소)', async () => {
    const temp = await makeTemporaryMember('s70t2');
    const sock1 = await connectReady(env.wsUrl, temp.accessToken);
    sock1.disconnect();
    // 1초 후 재연결(2초 debounce 이내) → 강퇴 잡 취소.
    await new Promise((r) => setTimeout(r, 1000));
    const sock2 = await connectReady(env.wsUrl, temp.accessToken);
    // 원래 debounce 발화 시점(+drainDelay)을 충분히 지나도 멤버 유지.
    await new Promise((r) => setTimeout(r, 4000));
    expect(await isMember(temp.userId)).toBe(true);
    sock2.disconnect();
  }, 20_000);

  it('다중 소켓: 한 소켓만 끊겨도 다른 소켓 연결 중이면 강퇴되지 않는다', async () => {
    const temp = await makeTemporaryMember('s70t3');
    const sockA = await connectReady(env.wsUrl, temp.accessToken);
    const sockB = await connectReady(env.wsUrl, temp.accessToken);
    sockA.disconnect();
    // sockB 가 살아있으므로 SCARD>0 → 강퇴 미실행.
    await new Promise((r) => setTimeout(r, 5000));
    expect(await isMember(temp.userId)).toBe(true);
    sockB.disconnect();
  }, 20_000);
});
