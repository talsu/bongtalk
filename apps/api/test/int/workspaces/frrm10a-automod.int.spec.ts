/**
 * FR-RM10a (063) AutoMod 키워드 모더레이션 통합 검증 — 실 Postgres + Redis(testcontainer).
 *
 * 검증 범위:
 *  - 규칙 CRUD: ADMIN 게이트(비-ADMIN 403) · 생성/목록/수정/삭제 + 감사(AUTOMOD_RULE_*).
 *  - BLOCK: 매칭 메시지 send 422(AUTOMOD_BLOCKED) + 메시지 미저장 + 감사(AUTOMOD_BLOCK).
 *  - ALERT: 매칭 메시지 정상 저장(201) + 감사(AUTOMOD_ALERT).
 *  - TIMEOUT: 매칭 메시지 422 + 작성자 mutedUntil 설정 + 감사(AUTOMOD_TIMEOUT).
 *  - exempt: 면제 채널/면제 역할 작성자는 규칙 통과(저장).
 *  - 편집 우회 차단: 정상 메시지를 매칭 본문으로 편집 시 422.
 *
 * ★S88 int 헬퍼 교훈: createRole 명시 position(낮은 값·FR-RM04 가드 회피) · beforeEach 의
 * MemberRole 정리는 시스템 역할 보존(role:{isSystem:false} 필터) · rate-limit 키 리셋(qufox:rl:*).
 *
 * 단일 파일 실행(OOM 회피): pnpm --filter @qufox/api test:int -- frrm10a-automod
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import {
  MsgIntEnv,
  ORIGIN,
  bearer,
  seedMessageStack,
  setupMsgIntEnv,
  type SeededStack,
} from '../messages/helpers';

let env: MsgIntEnv;
let stack: SeededStack;

let rolePositionSeq = 10;
async function createRole(name: string): Promise<string> {
  const position = rolePositionSeq;
  rolePositionSeq += 10;
  const res = await request(env.baseUrl)
    .post(`/workspaces/${stack.workspaceId}/roles`)
    .set('origin', ORIGIN)
    .set(bearer(stack.owner.accessToken))
    .send({ name, position });
  if (res.status !== 201) throw new Error(`createRole ${name}: ${res.status} ${res.text}`);
  return res.body.id as string;
}

async function assignRole(roleId: string, userId: string): Promise<void> {
  const res = await request(env.baseUrl)
    .post(`/workspaces/${stack.workspaceId}/roles/assign`)
    .set('origin', ORIGIN)
    .set(bearer(stack.owner.accessToken))
    .send({ roleId, userId });
  if (res.status >= 300) throw new Error(`assignRole: ${res.status} ${res.text}`);
}

/**
 * ★리뷰 F1: AutoMod 는 OWNER/ADMIN 작성자에게 적용하지 않는다(모더레이터 면제). 따라서 집행
 * (BLOCK/TIMEOUT)을 받는 "차단 대상"은 반드시 MEMBER 여야 한다. seed 의 nonMember 를 이
 * 워크스페이스에 MEMBER 로 합류시켜 면제되지 않는 두 번째 작성자를 확보한다(필요 시 1회).
 */
let secondMemberJoined = false;
async function ensureSecondMember(): Promise<void> {
  if (secondMemberJoined) return;
  const inv = await request(env.baseUrl)
    .post(`/workspaces/${stack.workspaceId}/invites`)
    .set('origin', ORIGIN)
    .set(bearer(stack.owner.accessToken))
    .send({ maxUses: 10 });
  const code = inv.body.invite.code as string;
  const acc = await request(env.baseUrl)
    .post(`/invites/${code}/accept`)
    .set('origin', ORIGIN)
    .set(bearer(stack.nonMember.accessToken));
  if (acc.status >= 300 && acc.status !== 409) {
    throw new Error(`ensureSecondMember accept: ${acc.status} ${acc.text}`);
  }
  secondMemberJoined = true;
}

async function createRule(body: Record<string, unknown>, token = stack.owner.accessToken) {
  return request(env.baseUrl)
    .post(`/workspaces/${stack.workspaceId}/automod-rules`)
    .set('origin', ORIGIN)
    .set(bearer(token))
    .send(body);
}

async function sendMessage(content: string, token: string, channelId = stack.channelId) {
  return request(env.baseUrl)
    .post(`/workspaces/${stack.workspaceId}/channels/${channelId}/messages`)
    .set('origin', ORIGIN)
    .set(bearer(token))
    .send({ content });
}

function auditCount(action: string): Promise<number> {
  return env.prisma.auditLog.count({ where: { workspaceId: stack.workspaceId, action } });
}

beforeAll(async () => {
  env = await setupMsgIntEnv();
  stack = await seedMessageStack(env.baseUrl);
}, 300_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

beforeEach(async () => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  await env.prisma.autoModRule.deleteMany({ where: { workspaceId: stack.workspaceId } });
  await env.prisma.message.deleteMany({ where: { channelId: stack.channelId } });
  await env.prisma.auditLog.deleteMany({ where: { workspaceId: stack.workspaceId } });
  await env.prisma.outboxEvent.deleteMany({});
  // 작성자 음소거 해제(TIMEOUT 테스트 누수 방지).
  await env.prisma.workspaceMember.updateMany({
    where: { workspaceId: stack.workspaceId },
    data: { mutedUntil: null },
  });
  // 비시스템 역할/할당 정리(시스템 역할 보존 — FR-RM04 가드 회피).
  await env.prisma.memberRole.deleteMany({
    where: { workspaceId: stack.workspaceId, role: { isSystem: false } },
  });
  await env.prisma.role.deleteMany({ where: { workspaceId: stack.workspaceId, isSystem: false } });
  // rate-limit 키 초기화(테스트 간 누수 방지).
  const keys = await env.redis.keys('qufox:rl:*');
  if (keys.length > 0) {
    await env.redis.del(...keys.map((k) => k.replace(/^qufox:/, '')));
  }
});

describe('FR-RM10a AutoMod rule CRUD (ADMIN gate)', () => {
  it('non-ADMIN(member) cannot create a rule → 403', async () => {
    const res = await createRule(
      {
        name: 'r',
        triggerType: 'KEYWORD',
        keywords: ['spam'],
        matchMode: 'SUBSTRING',
        action: 'BLOCK',
      },
      stack.member.accessToken,
    );
    expect(res.status).toBe(403);
  });

  it('ADMIN creates, lists, updates and deletes a rule with audits', async () => {
    const created = await createRule(
      {
        name: 'rule1',
        triggerType: 'KEYWORD',
        keywords: ['  SPAM ', 'spam'],
        matchMode: 'SUBSTRING',
        action: 'ALERT',
      },
      stack.admin.accessToken,
    );
    expect(created.status).toBe(201);
    // 키워드는 소문자 정규화 + 중복 제거되어 저장된다.
    expect(created.body.keywords).toEqual(['spam']);
    const ruleId = created.body.id as string;
    expect(await auditCount('AUTOMOD_RULE_CREATE')).toBe(1);

    const list = await request(env.baseUrl)
      .get(`/workspaces/${stack.workspaceId}/automod-rules`)
      .set('origin', ORIGIN)
      .set(bearer(stack.admin.accessToken));
    expect(list.status).toBe(200);
    expect(list.body.rules).toHaveLength(1);

    const upd = await request(env.baseUrl)
      .patch(`/workspaces/${stack.workspaceId}/automod-rules/${ruleId}`)
      .set('origin', ORIGIN)
      .set(bearer(stack.admin.accessToken))
      .send({ enabled: false });
    expect(upd.status).toBe(200);
    expect(upd.body.enabled).toBe(false);
    expect(await auditCount('AUTOMOD_RULE_UPDATE')).toBe(1);

    const del = await request(env.baseUrl)
      .delete(`/workspaces/${stack.workspaceId}/automod-rules/${ruleId}`)
      .set('origin', ORIGIN)
      .set(bearer(stack.admin.accessToken));
    expect(del.status).toBe(204);
    expect(await auditCount('AUTOMOD_RULE_DELETE')).toBe(1);
  });

  it('rejects TIMEOUT rule without timeoutSeconds (Zod refine) → 400', async () => {
    const res = await createRule({
      name: 'r',
      triggerType: 'KEYWORD',
      keywords: ['spam'],
      matchMode: 'SUBSTRING',
      action: 'TIMEOUT',
    });
    expect(res.status).toBe(400);
  });

  // ★리뷰 F3 (보안): exempt 역할/채널 ID 는 본 워크스페이스 소속이어야 한다(타 워크스페이스
  // UUID 주입 차단). 존재하지 않는/타 워크스페이스 UUID 면 400 VALIDATION_FAILED.
  it('rejects a rule whose exemptRoleIds are not in this workspace → 400', async () => {
    const res = await createRule({
      name: 'cross-ws-role',
      triggerType: 'KEYWORD',
      keywords: ['spam'],
      matchMode: 'SUBSTRING',
      action: 'BLOCK',
      // 유효 UUID 형식이지만 이 워크스페이스 역할이 아니다.
      exemptRoleIds: ['99999999-9999-4999-8999-999999999999'],
    });
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe('VALIDATION_FAILED');
  });

  it('rejects a rule whose exemptChannelIds are not in this workspace → 400', async () => {
    const res = await createRule({
      name: 'cross-ws-channel',
      triggerType: 'KEYWORD',
      keywords: ['spam'],
      matchMode: 'SUBSTRING',
      action: 'BLOCK',
      exemptChannelIds: ['88888888-8888-4888-8888-888888888888'],
    });
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe('VALIDATION_FAILED');
  });
});

describe('FR-RM10a AutoMod send/edit enforcement', () => {
  it('BLOCK: matching message is rejected (422) and not stored + audit', async () => {
    await createRule({
      name: 'block-rule',
      triggerType: 'KEYWORD',
      keywords: ['forbidden'],
      matchMode: 'SUBSTRING',
      action: 'BLOCK',
    });

    const res = await sendMessage('this is FORBIDDEN content', stack.member.accessToken);
    expect(res.status).toBe(422);
    expect(res.body.errorCode).toBe('AUTOMOD_BLOCKED');

    const stored = await env.prisma.message.count({
      where: { channelId: stack.channelId, deletedAt: null },
    });
    expect(stored).toBe(0);
    expect(await auditCount('AUTOMOD_BLOCK')).toBe(1);
  });

  it('clean message passes when a BLOCK rule does not match', async () => {
    await createRule({
      name: 'block-rule',
      triggerType: 'KEYWORD',
      keywords: ['forbidden'],
      matchMode: 'SUBSTRING',
      action: 'BLOCK',
    });
    const res = await sendMessage('a perfectly fine message', stack.member.accessToken);
    expect(res.status).toBe(201);
  });

  it('ALERT: matching message is stored (201) + audit AUTOMOD_ALERT', async () => {
    await createRule({
      name: 'alert-rule',
      triggerType: 'KEYWORD',
      keywords: ['watchword'],
      matchMode: 'SUBSTRING',
      action: 'ALERT',
    });
    const res = await sendMessage('contains watchword here', stack.member.accessToken);
    expect(res.status).toBe(201);
    const stored = await env.prisma.message.count({
      where: { channelId: stack.channelId, deletedAt: null },
    });
    expect(stored).toBe(1);
    expect(await auditCount('AUTOMOD_ALERT')).toBe(1);
  });

  it('TIMEOUT: matching message is rejected (422) + author muted + audit', async () => {
    await createRule({
      name: 'timeout-rule',
      triggerType: 'KEYWORD',
      keywords: ['banned-phrase'],
      matchMode: 'SUBSTRING',
      action: 'TIMEOUT',
      timeoutSeconds: 300,
    });
    const res = await sendMessage('using a banned-phrase now', stack.member.accessToken);
    expect(res.status).toBe(422);

    const member = await env.prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: { workspaceId: stack.workspaceId, userId: stack.member.userId },
      },
      select: { mutedUntil: true },
    });
    expect(member?.mutedUntil).not.toBeNull();
    expect(await auditCount('AUTOMOD_TIMEOUT')).toBe(1);
  });

  it('WORD mode does not match a substring inside a larger word', async () => {
    await createRule({
      name: 'word-rule',
      triggerType: 'KEYWORD',
      keywords: ['ass'],
      matchMode: 'WORD',
      action: 'BLOCK',
    });
    // 'classic' contains 'ass' as a substring but not as a word.
    const ok = await sendMessage('a classic example', stack.member.accessToken);
    expect(ok.status).toBe(201);
    // standalone word is blocked.
    const blocked = await sendMessage('what an ass!', stack.member.accessToken);
    expect(blocked.status).toBe(422);
  });

  it('exempt channel: rule does not apply in the exempt channel', async () => {
    // 별도 채널 생성 후 면제 목록에 등록.
    const ch2 = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels`)
      .set('origin', ORIGIN)
      .set(bearer(stack.owner.accessToken))
      .send({ name: `exempt-${Date.now().toString(36).slice(-6)}`, type: 'TEXT' });
    const exemptChannelId = ch2.body.id as string;

    await createRule({
      name: 'exempt-ch-rule',
      triggerType: 'KEYWORD',
      keywords: ['forbidden'],
      matchMode: 'SUBSTRING',
      action: 'BLOCK',
      exemptChannelIds: [exemptChannelId],
    });
    // 면제 채널에서는 통과(MEMBER 작성자 — F1 면제 대상 아님).
    const ok = await sendMessage('forbidden here is ok', stack.member.accessToken, exemptChannelId);
    expect(ok.status).toBe(201);
    // 일반 채널에서는 차단.
    const blocked = await sendMessage('forbidden here is blocked', stack.member.accessToken);
    expect(blocked.status).toBe(422);
  });

  it('exempt role: author holding the exempt role passes', async () => {
    await ensureSecondMember();
    const roleId = await createRole('Exempted');
    await assignRole(roleId, stack.member.userId);

    await createRule({
      name: 'exempt-role-rule',
      triggerType: 'KEYWORD',
      keywords: ['forbidden'],
      matchMode: 'SUBSTRING',
      action: 'BLOCK',
      exemptRoleIds: [roleId],
    });
    // 면제 역할 보유 member 는 통과.
    const ok = await sendMessage('forbidden but exempt', stack.member.accessToken);
    expect(ok.status).toBe(201);
    // 면제 역할 없는 두 번째 MEMBER 는 차단(★F1: admin/owner 는 면제라 차단 대상으로 못 씀).
    const blocked = await sendMessage('forbidden no exempt', stack.nonMember.accessToken);
    expect(blocked.status).toBe(422);
  });

  // ★리뷰 F1 (보안): AutoMod 는 OWNER/ADMIN 작성자에게 적용하지 않는다(모더레이터 면제 —
  // 악의적 ADMIN 이 'OWNER 단어'를 등록해 OWNER 를 자동 락아웃하는 계층 방어 우회 차단).
  it('AutoMod does not enforce against an ADMIN author (moderator exempt)', async () => {
    await createRule({
      name: 'admin-exempt',
      triggerType: 'KEYWORD',
      keywords: ['forbidden'],
      matchMode: 'SUBSTRING',
      action: 'BLOCK',
    });
    // ADMIN 작성자는 매칭 본문이어도 통과(저장).
    const adminRes = await sendMessage('this is FORBIDDEN content', stack.admin.accessToken);
    expect(adminRes.status).toBe(201);
    // OWNER 작성자도 통과.
    const ownerRes = await sendMessage('also FORBIDDEN here', stack.owner.accessToken);
    expect(ownerRes.status).toBe(201);
    // MEMBER 작성자는 동일 규칙에 차단(대조군).
    const memberRes = await sendMessage('member FORBIDDEN text', stack.member.accessToken);
    expect(memberRes.status).toBe(422);
    // ADMIN/OWNER 통과는 BLOCK 감사를 남기지 않는다(MEMBER 1건만).
    expect(await auditCount('AUTOMOD_BLOCK')).toBe(1);
  });

  it('TIMEOUT rule does not mute an ADMIN author (no AUTOMOD_TIMEOUT audit)', async () => {
    await createRule({
      name: 'admin-timeout-exempt',
      triggerType: 'KEYWORD',
      keywords: ['banned-phrase'],
      matchMode: 'SUBSTRING',
      action: 'TIMEOUT',
      timeoutSeconds: 300,
    });
    const res = await sendMessage('using a banned-phrase now', stack.admin.accessToken);
    expect(res.status).toBe(201);
    const adminMember = await env.prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: { workspaceId: stack.workspaceId, userId: stack.admin.userId },
      },
      select: { mutedUntil: true },
    });
    expect(adminMember?.mutedUntil).toBeNull();
    expect(await auditCount('AUTOMOD_TIMEOUT')).toBe(0);
  });

  // ★리뷰 F4 (한국어 정확성): WORD 경계가 유니코드 — 한국어 키워드가 더 큰 단어 안에서
  // SUBSTRING 으로 degrade 하지 않는다('욕설' WORD 룰 ≠ '욕설쟁이' · = 단독 '욕설').
  it('Korean WORD rule: matches standalone token but not inside a larger word', async () => {
    await createRule({
      name: 'korean-word',
      triggerType: 'KEYWORD',
      keywords: ['욕설'],
      matchMode: 'WORD',
      action: 'BLOCK',
    });
    // '욕설쟁이' 안의 '욕설' 은 WORD 매칭 아님 → 통과.
    const ok = await sendMessage('저 사람은 욕설쟁이야', stack.member.accessToken);
    expect(ok.status).toBe(201);
    // 단독 '욕설' 은 차단.
    const blocked = await sendMessage('그건 욕설 입니다', stack.member.accessToken);
    expect(blocked.status).toBe(422);
  });

  it('edit bypass is blocked: editing a clean message into a matching one → 422', async () => {
    await createRule({
      name: 'edit-rule',
      triggerType: 'KEYWORD',
      keywords: ['forbidden'],
      matchMode: 'SUBSTRING',
      action: 'BLOCK',
    });
    const sent = await sendMessage('clean message', stack.member.accessToken);
    expect(sent.status).toBe(201);
    const msgId = sent.body.message.id as string;
    const version = sent.body.message.version as number;

    const edit = await request(env.baseUrl)
      .patch(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages/${msgId}`)
      .set('origin', ORIGIN)
      .set(bearer(stack.member.accessToken))
      .send({ content: 'now forbidden', expectedVersion: version });
    expect(edit.status).toBe(422);
    expect(edit.body.errorCode).toBe('AUTOMOD_BLOCKED');

    // 원문은 그대로 유지(편집 미적용).
    const stored = await env.prisma.message.findUnique({ where: { id: msgId } });
    expect(stored?.content).toBe('clean message');
  });
});
