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
    // 면제 채널에서는 통과.
    const ok = await sendMessage('forbidden here is ok', stack.owner.accessToken, exemptChannelId);
    expect(ok.status).toBe(201);
    // 일반 채널에서는 차단.
    const blocked = await sendMessage('forbidden here is blocked', stack.owner.accessToken);
    expect(blocked.status).toBe(422);
  });

  it('exempt role: author holding the exempt role passes', async () => {
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
    // 면제 역할 없는 admin 은 차단.
    const blocked = await sendMessage('forbidden no exempt', stack.admin.accessToken);
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
