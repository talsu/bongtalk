/**
 * S72 (D13 / FR-W22) IP soft-block 통합 테스트:
 *  - ban 집행 시 대상 멤버의 가입 ipHash 가 BannedMember.ipHash 로 복사된다.
 *  - 차단 IP 에서의 PUBLIC 즉시 가입 → 허용(soft) + SUSPICIOUS_JOIN audit 기록(IP hard-block 금지).
 *  - 차단 IP 에서의 APPLY 가입 신청 → 403(중립 APPLICATION_NOT_APPLICABLE) 차단.
 *  - 동일 차단 IP 의 24h 내 SUSPICIOUS_JOIN 누적이 threshold(기본 3) 도달 → SUSPICIOUS_JOIN_
 *    THRESHOLD 모더레이션 알림(AuditLog flag) 추가 기록.
 *
 * trust proxy=1(helpers) 덕분에 X-Forwarded-For 의 첫 홉이 req.ip 로 복원되므로 supertest 의
 * XFF 헤더로 클라이언트 IP 를 제어해 차단 IP/비차단 IP 분기를 검증한다.
 *
 * 단일 파일 실행(OOM 회피): pnpm --filter @qufox/api test -- s72-ip-softblock
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { WsIntEnv, setupWsIntEnv, signupAsUser } from './helpers';

let env: WsIntEnv;
const ORIGIN = 'http://localhost:45173';

const BANNED_IP = '198.51.100.7';
const CLEAN_IP = '203.0.113.42';
const ipHashOf = (ip: string) => createHash('sha256').update(ip).digest('hex');

beforeAll(async () => {
  env = await setupWsIntEnv();
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

async function createPublicWorkspace(ownerToken: string, prefix: string): Promise<string> {
  const res = await request(env.baseUrl)
    .post('/workspaces')
    .set('origin', ORIGIN)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({
      name: prefix,
      slug: `${prefix}-${Date.now().toString(36)}`.slice(0, 30),
      visibility: 'PUBLIC',
      category: 'OTHER',
      description: 'ip soft-block test',
    })
    .expect(201);
  return res.body.id as string;
}

async function createApplyWorkspace(ownerToken: string, prefix: string): Promise<string> {
  const slug = `${prefix}-${Date.now().toString(36)}`.slice(0, 30);
  await request(env.baseUrl)
    .post('/workspaces')
    .set('origin', ORIGIN)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ name: prefix, slug, joinMode: 'APPLY' })
    .expect(201);
  return slug;
}

function suspiciousJoinCount(workspaceId: string, ipHash: string): Promise<number> {
  return env.prisma.auditLog.count({
    where: { workspaceId, ipHash, action: 'SUSPICIOUS_JOIN' },
  });
}

describe('S72 FR-W22: ban copies member.ipHash → BannedMember.ipHash', () => {
  it('PUBLIC 가입한 멤버를 ban 하면 그 멤버의 가입 ipHash 가 BannedMember 로 복사된다', async () => {
    const owner = await signupAsUser(env.baseUrl, 's72cpo');
    const joiner = await signupAsUser(env.baseUrl, 's72cpj');
    const wsId = await createPublicWorkspace(owner.accessToken, 's72cp');

    // joiner 가 BANNED_IP 에서 PUBLIC 가입 → WorkspaceMember.ipHash 기록.
    await request(env.baseUrl)
      .post(`/workspaces/${wsId}/join`)
      .set('Authorization', `Bearer ${joiner.accessToken}`)
      .set('X-Forwarded-For', BANNED_IP)
      .expect(201);

    const member = await env.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: wsId, userId: joiner.userId } },
      select: { ipHash: true },
    });
    expect(member?.ipHash).toBe(ipHashOf(BANNED_IP));

    // owner 가 joiner 를 ban → BannedMember.ipHash 에 같은 해시가 복사된다.
    await request(env.baseUrl)
      .post(`/workspaces/${wsId}/moderation/bans`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ userId: joiner.userId })
      .expect((r) => expect(r.status).toBeLessThan(400));

    const banned = await env.prisma.bannedMember.findUnique({
      where: { workspaceId_userId: { workspaceId: wsId, userId: joiner.userId } },
      select: { ipHash: true },
    });
    expect(banned?.ipHash).toBe(ipHashOf(BANNED_IP));
  });
});

describe('S72 FR-W22: PUBLIC join from a banned IP → allowed (soft) + SUSPICIOUS_JOIN', () => {
  it('차단 IP 에서의 PUBLIC 가입은 허용되고 SUSPICIOUS_JOIN 감사를 남긴다(IP hard-block 금지)', async () => {
    const owner = await signupAsUser(env.baseUrl, 's72spo');
    const firstJoiner = await signupAsUser(env.baseUrl, 's72spf');
    const wsId = await createPublicWorkspace(owner.accessToken, 's72sp');

    // 1) firstJoiner 가 BANNED_IP 에서 가입 후 ban → BannedMember.ipHash = BANNED_IP 해시.
    await request(env.baseUrl)
      .post(`/workspaces/${wsId}/join`)
      .set('Authorization', `Bearer ${firstJoiner.accessToken}`)
      .set('X-Forwarded-For', BANNED_IP)
      .expect(201);
    await request(env.baseUrl)
      .post(`/workspaces/${wsId}/moderation/bans`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ userId: firstJoiner.userId })
      .expect((r) => expect(r.status).toBeLessThan(400));

    // 2) 전혀 다른 사용자가 같은 BANNED_IP 에서 PUBLIC 가입 → 허용(201) + SUSPICIOUS_JOIN.
    const sharedIpUser = await signupAsUser(env.baseUrl, 's72sps');
    const join = await request(env.baseUrl)
      .post(`/workspaces/${wsId}/join`)
      .set('Authorization', `Bearer ${sharedIpUser.accessToken}`)
      .set('X-Forwarded-For', BANNED_IP);
    expect(join.status).toBe(201);
    expect(join.body.alreadyMember).toBe(false);

    // 멤버로 실제 들어갔는지(soft-allow — hard-block 아님) + SUSPICIOUS_JOIN 1건 기록.
    const member = await env.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: wsId, userId: sharedIpUser.userId } },
      select: { userId: true },
    });
    expect(member).not.toBeNull();
    expect(await suspiciousJoinCount(wsId, ipHashOf(BANNED_IP))).toBeGreaterThanOrEqual(1);
  });

  it('차단되지 않은(clean) IP 에서의 PUBLIC 가입은 SUSPICIOUS_JOIN 을 남기지 않는다', async () => {
    const owner = await signupAsUser(env.baseUrl, 's72clo');
    const joiner = await signupAsUser(env.baseUrl, 's72clj');
    const wsId = await createPublicWorkspace(owner.accessToken, 's72cl');

    await request(env.baseUrl)
      .post(`/workspaces/${wsId}/join`)
      .set('Authorization', `Bearer ${joiner.accessToken}`)
      .set('X-Forwarded-For', CLEAN_IP)
      .expect(201);

    expect(await suspiciousJoinCount(wsId, ipHashOf(CLEAN_IP))).toBe(0);
  });
});

describe('S72 FR-W22: APPLY submission from a banned IP → 403', () => {
  it('차단 IP 에서의 가입 신청(APPLY)은 즉시 403(APPLICATION_NOT_APPLICABLE)으로 차단된다', async () => {
    const owner = await signupAsUser(env.baseUrl, 's72apo');
    const firstJoiner = await signupAsUser(env.baseUrl, 's72apf');
    // APPLY 워크스페이스의 workspaceId 를 ban 호출에 쓰려고 별도 PUBLIC 가입은 못하니,
    // owner 가 firstJoiner 를 비멤버 ban 하되 ipHash 를 심기 위해 먼저 PUBLIC ws 로 가입→ban 한
    // 뒤, 그 BannedMember 가 *APPLY 워크스페이스* 에는 영향이 없으므로(워크스페이스 스코프),
    // APPLY 워크스페이스에 직접 BannedMember(ipHash) 를 심는다(ban 경로 단위 검증은 위 describe).
    const applySlug = await createApplyWorkspace(owner.accessToken, 's72ap');
    const applyWs = await env.prisma.workspace.findUnique({
      where: { slug: applySlug },
      select: { id: true },
    });
    const applyWsId = applyWs!.id;

    // APPLY 워크스페이스에 BANNED_IP 해시를 가진 차단 행을 직접 심는다(다른 사용자 userId).
    await env.prisma.bannedMember.create({
      data: {
        workspaceId: applyWsId,
        userId: firstJoiner.userId,
        bannedBy: owner.userId,
        ipHash: ipHashOf(BANNED_IP),
      },
    });

    // 전혀 다른 사용자가 같은 BANNED_IP 에서 신청 → 403(중립 APPLICATION_NOT_APPLICABLE).
    const applicant = await signupAsUser(env.baseUrl, 's72apa');
    const submit = await request(env.baseUrl)
      .post(`/workspaces/${applySlug}/applications`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${applicant.accessToken}`)
      .set('X-Forwarded-For', BANNED_IP)
      .send({ answers: [] });
    expect(submit.status).toBe(409);
    expect(submit.body.errorCode).toBe('APPLICATION_NOT_APPLICABLE');

    // 신청 행이 만들어지지 않았는지 확인(차단이 신청 생성 전에 일어남).
    const app = await env.prisma.workspaceMemberApplication.findFirst({
      where: { workspaceId: applyWsId, applicantId: applicant.userId },
    });
    expect(app).toBeNull();
  });

  it('차단되지 않은 IP 에서의 APPLY 신청은 정상 PENDING 으로 생성된다', async () => {
    const owner = await signupAsUser(env.baseUrl, 's72okv');
    const applySlug = await createApplyWorkspace(owner.accessToken, 's72ok');
    const applicant = await signupAsUser(env.baseUrl, 's72oka');

    const submit = await request(env.baseUrl)
      .post(`/workspaces/${applySlug}/applications`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${applicant.accessToken}`)
      .set('X-Forwarded-For', CLEAN_IP)
      .send({ answers: [] });
    expect(submit.status).toBe(201);
    expect(submit.body.status).toBe('PENDING');
  });
});

describe('S72 FR-W22: APPLY lifecycle records applicant IP → ban copies it → re-apply blocked', () => {
  it('APPLY submit(IP 기록) → approve(멤버 ipHash) → ban(BannedMember.ipHash) → 동일 IP 재신청 409', async () => {
    // reviewer BLOCKER-1: APPLY 는 신청자 IP(submit)와 승인자 IP(approve=admin)가 분리되므로,
    // submit 시점 신청자 ipHash 를 applicantIpHash 에 기록했다가 approve 가 멤버 ipHash 로
    // 복사해야 ban 시 BannedMember.ipHash 가 채워지고 APPLY soft-block 대조가 동작한다.
    const owner = await signupAsUser(env.baseUrl, 's72alo');
    const applicant = await signupAsUser(env.baseUrl, 's72ala');
    const applySlug = await createApplyWorkspace(owner.accessToken, 's72al');
    const applyWs = await env.prisma.workspace.findUnique({
      where: { slug: applySlug },
      select: { id: true },
    });
    const applyWsId = applyWs!.id;

    // 1) applicant 가 BANNED_IP 에서 신청 → applicantIpHash 기록.
    const submit = await request(env.baseUrl)
      .post(`/workspaces/${applySlug}/applications`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${applicant.accessToken}`)
      .set('X-Forwarded-For', BANNED_IP)
      .send({ answers: [] });
    expect(submit.status).toBe(201);
    const application = await env.prisma.workspaceMemberApplication.findFirst({
      where: { workspaceId: applyWsId, applicantId: applicant.userId },
      select: { id: true, applicantIpHash: true },
    });
    expect(application?.applicantIpHash).toBe(ipHashOf(BANNED_IP));

    // 2) owner 가 승인(admin IP — clean) → 멤버 ipHash 가 *신청자* IP 로 채워진다(admin 아님).
    const approve = await request(env.baseUrl)
      .patch(`/workspaces/${applySlug}/applications/${application!.id}`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .set('X-Forwarded-For', CLEAN_IP)
      .send({ action: 'approve' });
    expect(approve.status).toBe(200);
    const member = await env.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: applyWsId, userId: applicant.userId } },
      select: { ipHash: true },
    });
    expect(member?.ipHash).toBe(ipHashOf(BANNED_IP));

    // 3) owner 가 applicant 를 ban → BannedMember.ipHash 가 채워진다(멤버 ipHash 복사).
    await request(env.baseUrl)
      .post(`/workspaces/${applyWsId}/moderation/bans`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ userId: applicant.userId })
      .expect((r) => expect(r.status).toBeLessThan(400));
    const banned = await env.prisma.bannedMember.findUnique({
      where: { workspaceId_userId: { workspaceId: applyWsId, userId: applicant.userId } },
      select: { ipHash: true },
    });
    expect(banned?.ipHash).toBe(ipHashOf(BANNED_IP));

    // 4) 전혀 다른 사용자가 같은 BANNED_IP 에서 APPLY 재신청 → 409(중립) 차단(APPLY soft-block).
    const other = await signupAsUser(env.baseUrl, 's72alx');
    const reapply = await request(env.baseUrl)
      .post(`/workspaces/${applySlug}/applications`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${other.accessToken}`)
      .set('X-Forwarded-For', BANNED_IP)
      .send({ answers: [] });
    expect(reapply.status).toBe(409);
    expect(reapply.body.errorCode).toBe('APPLICATION_NOT_APPLICABLE');
  });
});

describe('S72 FR-W22: kick → undo preserves the member ipHash (reviewer MAJOR-2)', () => {
  it('kick→undo 후 ban 하면 IP 신호가 보존된다(BannedMember.ipHash 채워짐)', async () => {
    const owner = await signupAsUser(env.baseUrl, 's72kuo');
    const member = await signupAsUser(env.baseUrl, 's72kum');
    const wsId = await createPublicWorkspace(owner.accessToken, 's72ku');

    // member 가 BANNED_IP 에서 PUBLIC 가입 → ipHash 기록.
    await request(env.baseUrl)
      .post(`/workspaces/${wsId}/join`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .set('X-Forwarded-For', BANNED_IP)
      .expect(201);

    // owner 가 kick → undoToken 수령.
    const kick = await request(env.baseUrl)
      .post(`/workspaces/${wsId}/moderation/members/${member.userId}/kick`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({});
    expect(kick.status).toBeLessThan(400);
    const undoToken = kick.body.undoToken as string;
    expect(typeof undoToken).toBe('string');

    // undo 재가입 → ipHash 가 복원돼야 한다(kick 스냅샷).
    await request(env.baseUrl)
      .post(`/workspaces/${wsId}/moderation/members/${member.userId}/kick-undo`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ undoToken })
      .expect((r) => expect(r.status).toBeLessThan(400));
    const rejoined = await env.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: wsId, userId: member.userId } },
      select: { ipHash: true },
    });
    expect(rejoined?.ipHash).toBe(ipHashOf(BANNED_IP));

    // 이제 ban → BannedMember.ipHash 가 보존된 ipHash 로 채워진다(kick→undo 후에도 IP 신호 유지).
    await request(env.baseUrl)
      .post(`/workspaces/${wsId}/moderation/bans`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ userId: member.userId })
      .expect((r) => expect(r.status).toBeLessThan(400));
    const banned = await env.prisma.bannedMember.findUnique({
      where: { workspaceId_userId: { workspaceId: wsId, userId: member.userId } },
      select: { ipHash: true },
    });
    expect(banned?.ipHash).toBe(ipHashOf(BANNED_IP));
  });
});

describe('S72 FR-W22: 24h SUSPICIOUS_JOIN threshold → moderation flag', () => {
  it('동일 차단 IP 의 SUSPICIOUS_JOIN 이 threshold(기본 3) 도달 시 SUSPICIOUS_JOIN_THRESHOLD flag 를 남긴다', async () => {
    const owner = await signupAsUser(env.baseUrl, 's72tho');
    const seed = await signupAsUser(env.baseUrl, 's72ths');
    const wsId = await createPublicWorkspace(owner.accessToken, 's72th');

    // seed 가 BANNED_IP 에서 가입→ban → BannedMember.ipHash = BANNED_IP.
    await request(env.baseUrl)
      .post(`/workspaces/${wsId}/join`)
      .set('Authorization', `Bearer ${seed.accessToken}`)
      .set('X-Forwarded-For', BANNED_IP)
      .expect(201);
    await request(env.baseUrl)
      .post(`/workspaces/${wsId}/moderation/bans`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ userId: seed.userId })
      .expect((r) => expect(r.status).toBeLessThan(400));

    // 같은 BANNED_IP 에서 서로 다른 사용자 3명이 PUBLIC 가입 → SUSPICIOUS_JOIN 3건.
    for (let i = 0; i < 3; i += 1) {
      const u = await signupAsUser(env.baseUrl, `s72thu${i}`);
      await request(env.baseUrl)
        .post(`/workspaces/${wsId}/join`)
        .set('Authorization', `Bearer ${u.accessToken}`)
        .set('X-Forwarded-For', BANNED_IP)
        .expect(201);
    }

    const ipHash = ipHashOf(BANNED_IP);
    expect(await suspiciousJoinCount(wsId, ipHash)).toBeGreaterThanOrEqual(3);
    // threshold(3) 도달 → 알림 flag 가 최소 1건 기록된다.
    const flagCount = await env.prisma.auditLog.count({
      where: { workspaceId: wsId, ipHash, action: 'SUSPICIOUS_JOIN_THRESHOLD' },
    });
    expect(flagCount).toBeGreaterThanOrEqual(1);
  });
});
