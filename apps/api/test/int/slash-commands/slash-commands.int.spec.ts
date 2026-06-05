import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  bearer,
  ORIGIN,
  seedMessageStack,
  setupMsgIntEnv,
  type MsgIntEnv,
  type SeededStack,
} from '../messages/helpers';

/**
 * S79 (D15 / FR-SC-01·02) int spec: GET /workspaces/:wsId/slash-commands.
 *
 * 실제 Postgres testcontainer + 전체 Nest 앱(supertest)으로:
 *   - 빌트인 상수 + DB 커스텀 병합(FR-SC-01).
 *   - 멤버 권한 통과 / 비멤버 차단(WorkspaceMemberGuard — IDOR 방어로 404).
 *   - /giphy GIPHY_API_KEY env 게이트(미설정 시 제외, 설정 시 포함).
 *
 * 헬퍼는 messages int 헬퍼(setupMsgIntEnv/seedMessageStack)를 재사용한다 — signup 직후
 * emailVerified=true 마킹 포함(S66 무회귀). 실행/CRUD 는 S80/S81 범위라 다루지 않는다.
 */
describe('GET /workspaces/:wsId/slash-commands (int)', () => {
  let env: MsgIntEnv;
  let stack: SeededStack;
  // GIPHY 게이트 테스트가 끝나면 원복하기 위해 보관.
  let prevGiphy: string | undefined;

  beforeAll(async () => {
    prevGiphy = process.env.GIPHY_API_KEY;
    delete process.env.GIPHY_API_KEY; // 기본 비활성화 상태로 시작.
    env = await setupMsgIntEnv();
    stack = await seedMessageStack(env.baseUrl);
  }, 240_000);

  afterAll(async () => {
    if (prevGiphy === undefined) delete process.env.GIPHY_API_KEY;
    else process.env.GIPHY_API_KEY = prevGiphy;
    await env?.stop();
  });

  it('FR-SC-01: 멤버는 빌트인 커맨드 목록을 받는다(/giphy env 미설정 → 제외)', async () => {
    const res = await request(env.baseUrl)
      .get(`/workspaces/${stack.workspaceId}/slash-commands`)
      .set('origin', ORIGIN)
      .set(bearer(stack.member.accessToken));
    expect(res.status).toBe(200);
    const names = (res.body.items as Array<{ name: string; isBuiltin: boolean }>).map(
      (i) => i.name,
    );
    expect(names).toContain('shrug');
    expect(names).toContain('remind');
    expect(names).not.toContain('giphy');
    // 모든 빌트인 항목 isBuiltin=true.
    expect(
      (res.body.items as Array<{ isBuiltin: boolean }>).every((i) => i.isBuiltin === true),
    ).toBe(true);
  });

  it('FR-SC-01: GIPHY_API_KEY 설정 시 /giphy 가 목록에 포함된다', async () => {
    process.env.GIPHY_API_KEY = 'test-giphy-key';
    try {
      const res = await request(env.baseUrl)
        .get(`/workspaces/${stack.workspaceId}/slash-commands`)
        .set('origin', ORIGIN)
        .set(bearer(stack.member.accessToken));
      expect(res.status).toBe(200);
      const names = (res.body.items as Array<{ name: string }>).map((i) => i.name);
      expect(names).toContain('giphy');
    } finally {
      delete process.env.GIPHY_API_KEY;
    }
  });

  it('FR-SC-01: DB 커스텀 커맨드를 빌트인과 병합해 반환한다(isBuiltin=false)', async () => {
    // S81 CRUD 이전이라 DB 에 직접 커스텀 1건을 심는다(테이블은 커스텀 전용).
    const customId = await (async () => {
      const created = await env.prisma.slashCommand.create({
        data: {
          workspaceId: stack.workspaceId,
          name: 'deploy',
          description: '배포 트리거',
          usageHint: '/deploy [env]',
          responseType: 'EPHEMERAL',
          handlerType: 'INTERNAL_ACTION',
          enabled: true,
        },
      });
      return created.id;
    })();

    const res = await request(env.baseUrl)
      .get(`/workspaces/${stack.workspaceId}/slash-commands`)
      .set('origin', ORIGIN)
      .set(bearer(stack.owner.accessToken));
    expect(res.status).toBe(200);
    const items = res.body.items as Array<{ id: string; name: string; isBuiltin: boolean }>;
    const custom = items.find((i) => i.name === 'deploy');
    expect(custom).toBeDefined();
    expect(custom?.isBuiltin).toBe(false);
    expect(custom?.id).toBe(customId);
    // 빌트인은 여전히 존재(병합).
    expect(items.some((i) => i.name === 'shrug' && i.isBuiltin)).toBe(true);
  });

  it('FR-SC-01: disabled 커스텀 커맨드는 목록에서 제외된다', async () => {
    await env.prisma.slashCommand.create({
      data: {
        workspaceId: stack.workspaceId,
        name: 'hidden',
        description: '',
        usageHint: '',
        responseType: 'EPHEMERAL',
        handlerType: 'INTERNAL_ACTION',
        enabled: false,
      },
    });
    const res = await request(env.baseUrl)
      .get(`/workspaces/${stack.workspaceId}/slash-commands`)
      .set('origin', ORIGIN)
      .set(bearer(stack.owner.accessToken));
    const names = (res.body.items as Array<{ name: string }>).map((i) => i.name);
    expect(names).not.toContain('hidden');
  });

  it('비멤버는 슬래시 커맨드 목록에 접근할 수 없다(WorkspaceMemberGuard)', async () => {
    const res = await request(env.baseUrl)
      .get(`/workspaces/${stack.workspaceId}/slash-commands`)
      .set('origin', ORIGIN)
      .set(bearer(stack.nonMember.accessToken));
    // IDOR 방어: 멤버 아님은 404(WORKSPACE_NOT_MEMBER)로 응답한다(403 노출 안 함).
    expect(res.status).toBe(404);
  });

  it('인증 없이 접근하면 401', async () => {
    const res = await request(env.baseUrl)
      .get(`/workspaces/${stack.workspaceId}/slash-commands`)
      .set('origin', ORIGIN);
    expect([401, 403]).toContain(res.status);
  });
});
