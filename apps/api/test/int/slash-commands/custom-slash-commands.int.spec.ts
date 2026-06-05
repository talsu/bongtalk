import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  bearer,
  ORIGIN,
  seedMessageStack,
  setupMsgIntEnv,
  signup,
  type MsgIntEnv,
  type SeededStack,
} from '../messages/helpers';

/**
 * S81c (D15 / FR-SC-09·10) int spec — 워크스페이스 커스텀 슬래시 커맨드 CRUD + 실행.
 *
 * 실 Postgres + 실 Redis testcontainer + 전체 Nest 앱(supertest). 외부 호출 없음(GIPHY mock 불요).
 * 검증:
 *   - FR-SC-09: ADMIN 등록→조회(GET 병합 노출)→수정→삭제. 비관리자(MEMBER) 403. 빌트인충돌 409.
 *               워크스페이스 내 중복 409.
 *   - FR-SC-10: 커스텀 실행 actionType 별(EPHEMERAL_TEXT/SEND_TEMPLATE/REDIRECT_CHANNEL).
 *
 * 헬퍼는 messages int 헬퍼(owner/admin[ADMIN role]/member[MEMBER]/nonMember)를 재사용한다 —
 * signup 직후 emailVerified=true 마킹 포함(S66 무회귀).
 */
describe('Custom slash commands CRUD + execute (int)', () => {
  let env: MsgIntEnv;
  let stack: SeededStack;

  const crudUrl = (s: SeededStack) => `/workspaces/${s.workspaceId}/slash-commands`;
  const listUrl = (s: SeededStack) => `/workspaces/${s.workspaceId}/slash-commands`;
  const execUrl = (s: SeededStack) =>
    `/workspaces/${s.workspaceId}/channels/${s.channelId}/slash-commands/execute`;

  beforeAll(async () => {
    env = await setupMsgIntEnv();
    stack = await seedMessageStack(env.baseUrl);
  }, 240_000);

  afterAll(async () => {
    await env?.stop();
  });

  it('FR-SC-09: ADMIN 이 커스텀 커맨드를 등록한다(201·isBuiltin=false)', async () => {
    const res = await request(env.baseUrl)
      .post(crudUrl(stack))
      .set('origin', ORIGIN)
      .set(bearer(stack.admin.accessToken))
      .send({
        name: 'guide',
        description: '배포 가이드',
        usageHint: '/guide',
        action: { actionType: 'EPHEMERAL_TEXT', text: '가이드: https 링크' },
      });
    expect(res.status).toBe(201);
    expect(res.body.isBuiltin).toBe(false);
    expect(res.body.name).toBe('guide');
    expect(res.body.responseType).toBe('EPHEMERAL');

    // GET 목록(멤버)이 빌트인 + 이 커스텀을 병합해 노출한다.
    const list = await request(env.baseUrl)
      .get(listUrl(stack))
      .set('origin', ORIGIN)
      .set(bearer(stack.member.accessToken));
    expect(list.status).toBe(200);
    const names = (list.body.items as Array<{ name: string }>).map((i) => i.name);
    expect(names).toContain('guide');
    expect(names).toContain('shrug');
  });

  it('FR-SC-09: 비관리자(MEMBER)는 등록할 수 없다(403)', async () => {
    const res = await request(env.baseUrl)
      .post(crudUrl(stack))
      .set('origin', ORIGIN)
      .set(bearer(stack.member.accessToken))
      .send({ name: 'memberonly', action: { actionType: 'EPHEMERAL_TEXT', text: 'x' } });
    expect(res.status).toBe(403);
  });

  it('FR-SC-09: 빌트인명과 충돌하면 409', async () => {
    const res = await request(env.baseUrl)
      .post(crudUrl(stack))
      .set('origin', ORIGIN)
      .set(bearer(stack.owner.accessToken))
      .send({ name: 'shrug', action: { actionType: 'EPHEMERAL_TEXT', text: 'x' } });
    expect(res.status).toBe(409);
    expect(res.body.errorCode).toBe('SLASH_COMMAND_BUILTIN_CONFLICT');
  });

  it('FR-SC-09: 워크스페이스 내 중복 name 은 409', async () => {
    // 'guide' 는 첫 테스트에서 이미 등록됨.
    const res = await request(env.baseUrl)
      .post(crudUrl(stack))
      .set('origin', ORIGIN)
      .set(bearer(stack.admin.accessToken))
      .send({ name: 'guide', action: { actionType: 'EPHEMERAL_TEXT', text: '중복' } });
    expect(res.status).toBe(409);
    expect(res.body.errorCode).toBe('SLASH_COMMAND_DUPLICATE');
  });

  it('FR-SC-09: 대문자/sigil name 은 검증 실패(400)', async () => {
    const res = await request(env.baseUrl)
      .post(crudUrl(stack))
      .set('origin', ORIGIN)
      .set(bearer(stack.admin.accessToken))
      .send({ name: 'Bad Name', action: { actionType: 'EPHEMERAL_TEXT', text: 'x' } });
    expect(res.status).toBe(400);
  });

  it('FR-SC-09: ADMIN 이 수정(PATCH)·삭제(DELETE)한다 — 미존재는 404', async () => {
    // 등록 → PATCH → DELETE 라이프사이클.
    const created = await request(env.baseUrl)
      .post(crudUrl(stack))
      .set('origin', ORIGIN)
      .set(bearer(stack.admin.accessToken))
      .send({ name: 'tmp', action: { actionType: 'EPHEMERAL_TEXT', text: '원본' } });
    expect(created.status).toBe(201);
    const cmdId = created.body.id as string;

    const patched = await request(env.baseUrl)
      .patch(`${crudUrl(stack)}/${cmdId}`)
      .set('origin', ORIGIN)
      .set(bearer(stack.admin.accessToken))
      .send({ description: '수정됨', enabled: false });
    expect(patched.status).toBe(200);

    // disabled → GET 목록에서 제외.
    const list = await request(env.baseUrl)
      .get(listUrl(stack))
      .set('origin', ORIGIN)
      .set(bearer(stack.member.accessToken));
    expect((list.body.items as Array<{ name: string }>).map((i) => i.name)).not.toContain('tmp');

    const deleted = await request(env.baseUrl)
      .delete(`${crudUrl(stack)}/${cmdId}`)
      .set('origin', ORIGIN)
      .set(bearer(stack.admin.accessToken));
    expect(deleted.status).toBe(204);

    // 재삭제는 404.
    const again = await request(env.baseUrl)
      .delete(`${crudUrl(stack)}/${cmdId}`)
      .set('origin', ORIGIN)
      .set(bearer(stack.admin.accessToken));
    expect(again.status).toBe(404);
  });

  it('security MED(WorkspaceMemberGuard): 비멤버는 POST/PATCH/DELETE 모두 404', async () => {
    // 먼저 ADMIN 으로 대상 커맨드 하나를 만들어 둔다(PATCH/DELETE 표적).
    const created = await request(env.baseUrl)
      .post(crudUrl(stack))
      .set('origin', ORIGIN)
      .set(bearer(stack.admin.accessToken))
      .send({ name: 'nm-target', action: { actionType: 'EPHEMERAL_TEXT', text: 'x' } });
    expect(created.status).toBe(201);
    const cmdId = created.body.id as string;

    // 비멤버(stack.nonMember)는 WorkspaceMemberGuard 에서 404(WORKSPACE_NOT_MEMBER) —
    // 존재 자체를 누출하지 않는다(403 아님 · 가드 주석 명시).
    const post = await request(env.baseUrl)
      .post(crudUrl(stack))
      .set('origin', ORIGIN)
      .set(bearer(stack.nonMember.accessToken))
      .send({ name: 'nm-create', action: { actionType: 'EPHEMERAL_TEXT', text: 'x' } });
    expect(post.status).toBe(404);

    const patch = await request(env.baseUrl)
      .patch(`${crudUrl(stack)}/${cmdId}`)
      .set('origin', ORIGIN)
      .set(bearer(stack.nonMember.accessToken))
      .send({ description: '침입' });
    expect(patch.status).toBe(404);

    const del = await request(env.baseUrl)
      .delete(`${crudUrl(stack)}/${cmdId}`)
      .set('origin', ORIGIN)
      .set(bearer(stack.nonMember.accessToken));
    expect(del.status).toBe(404);

    // 비멤버 시도 후에도 원본 커맨드는 그대로 살아 있어야 한다(삭제 미수행 확인).
    const stillThere = await env.prisma.slashCommand.findUnique({ where: { id: cmdId } });
    expect(stillThere).not.toBeNull();
  });

  it('security MED(cross-ws IDOR): 타 워크스페이스 cmdId 의 PATCH/DELETE 는 404(스코프 거부)', async () => {
    // 워크스페이스 A(stack)에 ADMIN 이 커맨드를 만든다.
    const created = await request(env.baseUrl)
      .post(crudUrl(stack))
      .set('origin', ORIGIN)
      .set(bearer(stack.admin.accessToken))
      .send({
        name: 'idor-target',
        description: 'A 소유',
        action: { actionType: 'EPHEMERAL_TEXT', text: 'A 본문' },
      });
    expect(created.status).toBe(201);
    const cmdIdA = created.body.id as string;

    // 별도 워크스페이스 B 를 만든다(다른 OWNER — B 의 관리자).
    const ownerB = await signup(env.baseUrl, 'idorb');
    const wsB = await request(env.baseUrl)
      .post('/workspaces')
      .set('origin', ORIGIN)
      .set(bearer(ownerB.accessToken))
      .send({ name: 'IdorWsB', slug: `idor-ws-b-${Date.now().toString(36)}` });
    expect(wsB.status).toBe(201);
    const wsIdB = wsB.body.id as string;

    // B 의 OWNER 가 A 의 cmdId 를 B 의 URL 스코프로 PATCH → updateMany({id, workspaceId:B})
    // count 0 → 404(존재 누출 없이 NOT_FOUND · TOCTOU 없는 단일 원자 쿼리).
    const patch = await request(env.baseUrl)
      .patch(`/workspaces/${wsIdB}/slash-commands/${cmdIdA}`)
      .set('origin', ORIGIN)
      .set(bearer(ownerB.accessToken))
      .send({ description: '교차 침입' });
    expect(patch.status).toBe(404);
    expect(patch.body.errorCode).toBe('SLASH_COMMAND_NOT_FOUND');

    const del = await request(env.baseUrl)
      .delete(`/workspaces/${wsIdB}/slash-commands/${cmdIdA}`)
      .set('origin', ORIGIN)
      .set(bearer(ownerB.accessToken));
    expect(del.status).toBe(404);
    expect(del.body.errorCode).toBe('SLASH_COMMAND_NOT_FOUND');

    // A 소유 커맨드는 변경/삭제되지 않고 그대로다(스코프 격리 확인).
    const intact = await env.prisma.slashCommand.findUnique({ where: { id: cmdIdA } });
    expect(intact?.description).toBe('A 소유');
  });

  it('FR-SC-10: SEND_TEMPLATE 실행 → {args} 치환 후 채널에 메시지 게시(IN_CHANNEL)', async () => {
    const created = await request(env.baseUrl)
      .post(crudUrl(stack))
      .set('origin', ORIGIN)
      .set(bearer(stack.admin.accessToken))
      .send({
        name: 'announce',
        action: { actionType: 'SEND_TEMPLATE', template: '공지: {args}' },
      });
    expect(created.status).toBe(201);

    const exec = await request(env.baseUrl)
      .post(execUrl(stack))
      .set('origin', ORIGIN)
      .set(bearer(stack.member.accessToken))
      .send({ command: 'announce', text: '점검 예정', idempotencyKey: randomUUID() });
    expect(exec.status).toBe(201);
    expect(exec.body.responseType).toBe('IN_CHANNEL');
    const msg = await env.prisma.message.findUnique({ where: { id: exec.body.messageId } });
    expect(msg?.content).toBe('공지: 점검 예정');
    expect(msg?.authorId).toBe(stack.member.userId);
  });

  it('FR-SC-10: EPHEMERAL_TEXT 실행 → 발신자 전용 안내(채널 미게시)', async () => {
    const before = await env.prisma.message.count({ where: { channelId: stack.channelId } });
    const exec = await request(env.baseUrl)
      .post(execUrl(stack))
      .set('origin', ORIGIN)
      .set(bearer(stack.member.accessToken))
      .send({ command: 'guide', text: '', idempotencyKey: randomUUID() });
    expect(exec.status).toBe(201);
    expect(exec.body.responseType).toBe('EPHEMERAL');
    expect(exec.body.content).toContain('가이드');
    const after = await env.prisma.message.count({ where: { channelId: stack.channelId } });
    expect(after).toBe(before);
  });

  it('FR-SC-10: REDIRECT_CHANNEL 실행 → 접근 가능한 채널이면 navigate(channel)', async () => {
    const created = await request(env.baseUrl)
      .post(crudUrl(stack))
      .set('origin', ORIGIN)
      .set(bearer(stack.admin.accessToken))
      .send({
        name: 'go',
        action: { actionType: 'REDIRECT_CHANNEL', channelId: stack.channelId },
      });
    expect(created.status).toBe(201);

    const exec = await request(env.baseUrl)
      .post(execUrl(stack))
      .set('origin', ORIGIN)
      .set(bearer(stack.member.accessToken))
      .send({ command: 'go', text: '', idempotencyKey: randomUUID() });
    expect(exec.status).toBe(201);
    expect(exec.body.responseType).toBe('EPHEMERAL');
    // S81c 리뷰 fix-forward(MAJOR-1): navigate 는 canonical 라우트(`/w/:slug/:channelName`)를
    // 구성할 slug + channelName 을 싣는다(존재하지 않는 `/c/:channelId` 가 아니다). 서버가 채널·
    // 워크스페이스를 실제 조회해 실어주므로 DB 의 채널 name + 워크스페이스 slug 와 일치해야 한다.
    const ch = await env.prisma.channel.findUnique({
      where: { id: stack.channelId },
      select: { name: true, workspace: { select: { slug: true } } },
    });
    expect(exec.body.navigate).toEqual({
      kind: 'channel',
      channelId: stack.channelId,
      slug: ch?.workspace?.slug,
      channelName: ch?.name,
    });
  });

  it('FR-SC-10: 미존재 커스텀 커맨드는 SLASH_COMMAND_UNKNOWN(404)', async () => {
    const exec = await request(env.baseUrl)
      .post(execUrl(stack))
      .set('origin', ORIGIN)
      .set(bearer(stack.member.accessToken))
      .send({ command: 'doesnotexist', text: '', idempotencyKey: randomUUID() });
    expect(exec.status).toBe(404);
    expect(exec.body.errorCode).toBe('SLASH_COMMAND_UNKNOWN');
  });
});
