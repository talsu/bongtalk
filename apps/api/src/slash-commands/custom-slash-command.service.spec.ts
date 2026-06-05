import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import type { CreateCustomCommandRequest } from '@qufox/shared-types';
import {
  CustomSlashCommandService,
  actionToParams,
  deriveTypes,
  normalizeName,
} from './custom-slash-command.service';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';

/**
 * S81c (D15 / FR-SC-09) 단위 테스트 — 커스텀 슬래시 커맨드 CRUD 서비스.
 *
 * 외부(Prisma)는 vi.fn() 으로만 모킹한다(외부 모킹 라이브러리 금지). 빌트인명 충돌 409·
 * 워크스페이스 내 중복 409(P2002)·소유 스코프(PATCH/DELETE 미존재 404)·name normalize·
 * actionType→responseType 도출·actionParams 직렬화를 검증한다. 시간 고정(2025-01-01).
 */

const WS_ID = '11111111-1111-1111-1111-111111111111';
const ME_ID = '33333333-3333-3333-3333-333333333333';
const CMD_ID = '99999999-9999-9999-9999-999999999999';

function makeService(overrides?: {
  create?: ReturnType<typeof vi.fn>;
  findFirst?: ReturnType<typeof vi.fn>;
  findUnique?: ReturnType<typeof vi.fn>;
  updateMany?: ReturnType<typeof vi.fn>;
  deleteMany?: ReturnType<typeof vi.fn>;
}) {
  const create =
    overrides?.create ??
    vi.fn(async () => ({
      id: CMD_ID,
      name: 'deploy',
      description: '',
      usageHint: '',
      responseType: 'EPHEMERAL',
      handlerType: 'INTERNAL_ACTION',
    }));
  const findFirst = overrides?.findFirst ?? vi.fn(async () => ({ id: CMD_ID }));
  // S81c 리뷰 fix-forward(#5): update() 는 updateMany({id,workspaceId}) 원자 갱신 후 findUnique
  // 재조회로 바뀌었다(TOCTOU 제거). 기본 mock 은 1건 갱신 + 갱신된 행 반환.
  const updateMany = overrides?.updateMany ?? vi.fn(async () => ({ count: 1 }));
  const findUnique =
    overrides?.findUnique ??
    vi.fn(async () => ({
      id: CMD_ID,
      name: 'deploy',
      description: 'x',
      usageHint: '',
      responseType: 'EPHEMERAL',
      handlerType: 'INTERNAL_ACTION',
    }));
  const deleteMany = overrides?.deleteMany ?? vi.fn(async () => ({ count: 1 }));
  const prisma = {
    slashCommand: { create, findFirst, findUnique, updateMany, deleteMany },
  };
  const svc = new CustomSlashCommandService(prisma as never);
  return { svc, create, findFirst, findUnique, updateMany, deleteMany };
}

const ephemeralReq: CreateCustomCommandRequest = {
  name: 'deploy',
  description: '',
  usageHint: '',
  action: { actionType: 'EPHEMERAL_TEXT', text: '배포 안내' },
  enabled: true,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('CustomSlashCommandService.create', () => {
  it('정상 등록 시 isBuiltin=false 항목을 반환한다', async () => {
    const { svc, create } = makeService();
    const item = await svc.create(WS_ID, ME_ID, ephemeralReq);
    expect(item.isBuiltin).toBe(false);
    expect(item.name).toBe('deploy');
    // EPHEMERAL_TEXT → responseType EPHEMERAL, handlerType INTERNAL_ACTION, params { text }.
    const arg = create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(arg.data.responseType).toBe('EPHEMERAL');
    expect(arg.data.handlerType).toBe('INTERNAL_ACTION');
    expect(arg.data.actionType).toBe('EPHEMERAL_TEXT');
    expect(arg.data.actionParams).toEqual({ text: '배포 안내' });
    expect(arg.data.createdBy).toBe(ME_ID);
  });

  it('SEND_TEMPLATE 는 responseType IN_CHANNEL 로 저장된다', async () => {
    const { svc, create } = makeService();
    await svc.create(WS_ID, ME_ID, {
      ...ephemeralReq,
      action: { actionType: 'SEND_TEMPLATE', template: '안녕 {args}' },
    });
    const arg = create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(arg.data.responseType).toBe('IN_CHANNEL');
    expect(arg.data.actionParams).toEqual({ template: '안녕 {args}' });
  });

  it('빌트인명과 충돌하면 409 SLASH_COMMAND_BUILTIN_CONFLICT', async () => {
    const { svc, create } = makeService();
    await expect(
      svc.create(WS_ID, ME_ID, { ...ephemeralReq, name: 'shrug' }),
    ).rejects.toMatchObject({ code: ErrorCode.SLASH_COMMAND_BUILTIN_CONFLICT });
    expect(create).not.toHaveBeenCalled();
  });

  it('대소문자 빌트인명도 normalize 후 충돌 차단(GIPHY)', async () => {
    const { svc } = makeService();
    await expect(
      svc.create(WS_ID, ME_ID, { ...ephemeralReq, name: 'GIPHY' }),
    ).rejects.toMatchObject({ code: ErrorCode.SLASH_COMMAND_BUILTIN_CONFLICT });
  });

  it('워크스페이스 내 중복(P2002)은 409 SLASH_COMMAND_DUPLICATE 로 흡수한다', async () => {
    const create = vi.fn(async () => {
      throw new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'x',
      });
    });
    const { svc } = makeService({ create });
    await expect(svc.create(WS_ID, ME_ID, ephemeralReq)).rejects.toMatchObject({
      code: ErrorCode.SLASH_COMMAND_DUPLICATE,
    });
  });

  it('name 을 소문자/trim normalize 해 저장한다', async () => {
    const { svc, create } = makeService();
    await svc.create(WS_ID, ME_ID, { ...ephemeralReq, name: '  Deploy  ' as never });
    const arg = create.mock.calls[0][0] as { data: { name: string } };
    expect(arg.data.name).toBe('deploy');
  });
});

describe('CustomSlashCommandService.update', () => {
  it('미존재(다른 워크스페이스 포함) PATCH 는 404 SLASH_COMMAND_NOT_FOUND', async () => {
    // updateMany count===0(소유 스코프 밖) → NOT_FOUND. 재조회(findUnique)는 도달하지 않는다.
    const { svc, findUnique } = makeService({ updateMany: vi.fn(async () => ({ count: 0 })) });
    await expect(svc.update(WS_ID, CMD_ID, { description: 'x' })).rejects.toMatchObject({
      code: ErrorCode.SLASH_COMMAND_NOT_FOUND,
    });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('updateMany 는 workspaceId 스코프를 where 에 포함한다(TOCTOU/IDOR 방지)', async () => {
    const { svc, updateMany } = makeService();
    await svc.update(WS_ID, CMD_ID, { description: 'x' });
    const arg = updateMany.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(arg.where).toEqual({ id: CMD_ID, workspaceId: WS_ID });
  });

  it('name 변경 시 빌트인 충돌을 다시 차단한다', async () => {
    const { svc, updateMany } = makeService();
    await expect(svc.update(WS_ID, CMD_ID, { name: 'me' })).rejects.toMatchObject({
      code: ErrorCode.SLASH_COMMAND_BUILTIN_CONFLICT,
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('부분 갱신(action 만)은 responseType/actionParams 를 함께 갱신한다', async () => {
    const { svc, updateMany } = makeService();
    await svc.update(WS_ID, CMD_ID, {
      action: { actionType: 'REDIRECT_CHANNEL', channelId: WS_ID },
    });
    const arg = updateMany.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(arg.data.responseType).toBe('EPHEMERAL');
    expect(arg.data.actionType).toBe('REDIRECT_CHANNEL');
    expect(arg.data.actionParams).toEqual({ channelId: WS_ID });
  });
});

describe('CustomSlashCommandService.remove', () => {
  it('소유 스코프 삭제 1건이면 성공(예외 없음)', async () => {
    const { svc } = makeService();
    await expect(svc.remove(WS_ID, CMD_ID)).resolves.toBeUndefined();
  });

  it('삭제 0건이면 404 SLASH_COMMAND_NOT_FOUND', async () => {
    const { svc } = makeService({ deleteMany: vi.fn(async () => ({ count: 0 })) });
    await expect(svc.remove(WS_ID, CMD_ID)).rejects.toMatchObject({
      code: ErrorCode.SLASH_COMMAND_NOT_FOUND,
    });
  });
});

describe('순수 헬퍼', () => {
  it('normalizeName: trim + lowercase', () => {
    expect(normalizeName('  Foo_Bar ')).toBe('foo_bar');
  });

  it('deriveTypes: SEND_TEMPLATE → IN_CHANNEL, 그 외 EPHEMERAL', () => {
    expect(deriveTypes({ actionType: 'SEND_TEMPLATE', template: 't' })).toEqual({
      responseType: 'IN_CHANNEL',
      handlerType: 'INTERNAL_ACTION',
    });
    expect(deriveTypes({ actionType: 'EPHEMERAL_TEXT', text: 't' })).toEqual({
      responseType: 'EPHEMERAL',
      handlerType: 'INTERNAL_ACTION',
    });
    expect(deriveTypes({ actionType: 'REDIRECT_CHANNEL', channelId: WS_ID }).responseType).toBe(
      'EPHEMERAL',
    );
  });

  it('actionToParams: actionType 키 제외하고 본문만 직렬화', () => {
    expect(actionToParams({ actionType: 'EPHEMERAL_TEXT', text: 'x' })).toEqual({ text: 'x' });
    expect(actionToParams({ actionType: 'SEND_TEMPLATE', template: 'y' })).toEqual({
      template: 'y',
    });
    expect(actionToParams({ actionType: 'REDIRECT_CHANNEL', channelId: WS_ID })).toEqual({
      channelId: WS_ID,
    });
  });

  // DomainError 가 throw 되면 그 code 가 위 매핑(ERROR_CODE_HTTP_STATUS)으로 409/404 가 됨은
  // error-code-schema.unit.spec.ts(parity) + error-code.spec.ts 가 보증한다.
  it('DomainError 는 code 를 보존한다(필터 매핑 입력)', () => {
    const err = new DomainError(ErrorCode.SLASH_COMMAND_BUILTIN_CONFLICT, 'x');
    expect(err.code).toBe(ErrorCode.SLASH_COMMAND_BUILTIN_CONFLICT);
  });
});
