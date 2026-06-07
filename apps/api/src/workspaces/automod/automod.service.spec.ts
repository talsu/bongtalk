import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AutoModService } from './automod.service';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';
import { AuditAction } from '../../common/audit/audit.service';

/**
 * FR-RM10a (063) 단위 테스트 — AutoMod 키워드 모더레이션 서비스.
 *
 * 외부(Prisma/Audit/Moderation)는 vi.fn() 으로만 모킹한다(외부 모킹 라이브러리 금지).
 * check() 의 SUBSTRING/WORD 매칭·대소문자 무시·exempt role/channel·DM skip·캐시 무효화와
 * CRUD 의 감사 기록·소유 스코프를 검증한다. 시간 고정(2025-01-01).
 */

const WS = '11111111-1111-1111-1111-111111111111';
const CH = '22222222-2222-2222-2222-222222222222';
const AUTHOR = '33333333-3333-3333-3333-333333333333';
const ROLE_A = '44444444-4444-4444-4444-444444444444';
const ROLE_B = '55555555-5555-5555-5555-555555555555';
const RULE = '66666666-6666-6666-6666-666666666666';

interface RuleRow {
  id: string;
  workspaceId: string;
  name: string;
  triggerType: string;
  keywords: string[];
  matchMode: 'SUBSTRING' | 'WORD';
  action: 'BLOCK' | 'ALERT' | 'TIMEOUT';
  timeoutSeconds: number | null;
  exemptRoleIds: string[];
  exemptChannelIds: string[];
  enabled: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

function ruleRow(over: Partial<RuleRow>): RuleRow {
  return {
    id: RULE,
    workspaceId: WS,
    name: 'rule',
    triggerType: 'KEYWORD',
    keywords: ['spam'],
    matchMode: 'SUBSTRING',
    action: 'BLOCK',
    timeoutSeconds: null,
    exemptRoleIds: [],
    exemptChannelIds: [],
    enabled: true,
    createdBy: AUTHOR,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    ...over,
  };
}

function makeService(opts?: {
  findMany?: ReturnType<typeof vi.fn>;
  count?: ReturnType<typeof vi.fn>;
  create?: ReturnType<typeof vi.fn>;
  update?: ReturnType<typeof vi.fn>;
  deleteMany?: ReturnType<typeof vi.fn>;
  findFirst?: ReturnType<typeof vi.fn>;
  // 리뷰 F1: 작성자 멤버십 조회(actorRole 미지정 시 면제 판정). 기본은 MEMBER(비면제).
  memberFindUnique?: ReturnType<typeof vi.fn>;
  // 리뷰 F3: exempt 소유 검증용 role/channel findMany. 기본은 입력 그대로 모두 발견(통과).
  roleFindMany?: ReturnType<typeof vi.fn>;
  channelFindMany?: ReturnType<typeof vi.fn>;
}) {
  const findMany = opts?.findMany ?? vi.fn(async () => []);
  const count = opts?.count ?? vi.fn(async () => 0);
  const create = opts?.create ?? vi.fn(async () => ruleRow({}));
  const update = opts?.update ?? vi.fn(async () => ruleRow({}));
  const deleteMany = opts?.deleteMany ?? vi.fn(async () => ({ count: 1 }));
  const findFirst = opts?.findFirst ?? vi.fn(async () => ({ id: RULE }));
  const memberFindUnique = opts?.memberFindUnique ?? vi.fn(async () => ({ role: 'MEMBER' }));
  // 기본 roleFindMany/channelFindMany: 요청된 id 를 그대로 반환(전부 소속 → 통과).
  const roleFindMany =
    opts?.roleFindMany ??
    vi.fn(async (q: { where: { id: { in: string[] } } }) =>
      q.where.id.in.map((id: string) => ({ id })),
    );
  const channelFindMany =
    opts?.channelFindMany ??
    vi.fn(async (q: { where: { id: { in: string[] } } }) =>
      q.where.id.in.map((id: string) => ({ id })),
    );
  const auditCreate = vi.fn(async () => undefined);
  const txClient = {
    autoModRule: { create, update, deleteMany },
    auditLog: { create: auditCreate },
  };
  const prisma = {
    autoModRule: { findMany, count, findFirst },
    workspaceMember: { findUnique: memberFindUnique },
    role: { findMany: roleFindMany },
    channel: { findMany: channelFindMany },
    $transaction: vi.fn(async (cb: (tx: typeof txClient) => unknown) => cb(txClient)),
  };
  const auditRecord = vi.fn(async () => undefined);
  const audit = { record: auditRecord };
  const timeoutBySystem = vi.fn(async () => ({ userId: AUTHOR, mutedUntil: 'x' }));
  const moderation = { timeoutBySystem };
  const svc = new AutoModService(prisma as never, audit as never, moderation as never);
  return {
    svc,
    findMany,
    count,
    create,
    update,
    deleteMany,
    findFirst,
    memberFindUnique,
    roleFindMany,
    channelFindMany,
    auditRecord,
    timeoutBySystem,
  };
}

describe('AutoModService.check', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  });

  it('returns null for DM (workspaceId null) without hitting the DB', async () => {
    const { svc, findMany } = makeService();
    const hit = await svc.check({
      workspaceId: null,
      channelId: CH,
      authorId: AUTHOR,
      actorRoleIds: [],
      contentPlain: 'spam here',
    });
    expect(hit).toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('matches SUBSTRING case-insensitively and returns BLOCK', async () => {
    const { svc } = makeService({ findMany: vi.fn(async () => [ruleRow({ keywords: ['spam'] })]) });
    const hit = await svc.check({
      workspaceId: WS,
      channelId: CH,
      authorId: AUTHOR,
      actorRoleIds: [],
      contentPlain: 'This is SPAMMY text',
    });
    expect(hit?.action).toBe('BLOCK');
    expect(hit?.keyword).toBe('spam');
  });

  it('SUBSTRING matches mid-word; WORD does not match a substring inside a word', async () => {
    const sub = makeService({
      findMany: vi.fn(async () => [ruleRow({ keywords: ['ass'], matchMode: 'SUBSTRING' })]),
    });
    expect(
      (
        await sub.svc.check({
          workspaceId: WS,
          channelId: CH,
          authorId: AUTHOR,
          actorRoleIds: [],
          contentPlain: 'classic',
        })
      )?.action,
    ).toBe('BLOCK');

    const word = makeService({
      findMany: vi.fn(async () => [ruleRow({ keywords: ['ass'], matchMode: 'WORD' })]),
    });
    expect(
      await word.svc.check({
        workspaceId: WS,
        channelId: CH,
        authorId: AUTHOR,
        actorRoleIds: [],
        contentPlain: 'classic',
      }),
    ).toBeNull();
  });

  it('WORD matches a standalone token (boundary by space/punctuation)', async () => {
    const { svc } = makeService({
      findMany: vi.fn(async () => [ruleRow({ keywords: ['bad'], matchMode: 'WORD' })]),
    });
    const hit = await svc.check({
      workspaceId: WS,
      channelId: CH,
      authorId: AUTHOR,
      actorRoleIds: [],
      contentPlain: 'you are bad!',
    });
    expect(hit?.keyword).toBe('bad');
  });

  it('skips a rule when the channel is exempt', async () => {
    const { svc } = makeService({
      findMany: vi.fn(async () => [ruleRow({ keywords: ['spam'], exemptChannelIds: [CH] })]),
    });
    const hit = await svc.check({
      workspaceId: WS,
      channelId: CH,
      authorId: AUTHOR,
      actorRoleIds: [],
      contentPlain: 'spam',
    });
    expect(hit).toBeNull();
  });

  it('skips a rule when the author holds an exempt role', async () => {
    const { svc } = makeService({
      findMany: vi.fn(async () => [ruleRow({ keywords: ['spam'], exemptRoleIds: [ROLE_A] })]),
    });
    const hit = await svc.check({
      workspaceId: WS,
      channelId: CH,
      authorId: AUTHOR,
      actorRoleIds: [ROLE_B, ROLE_A],
      contentPlain: 'spam',
    });
    expect(hit).toBeNull();
  });

  it('returns the first matching rule (ordered) when several match', async () => {
    const { svc } = makeService({
      findMany: vi.fn(async () => [
        ruleRow({ id: 'first', keywords: ['nope'] }),
        ruleRow({ id: 'second', keywords: ['spam'], action: 'ALERT' }),
        ruleRow({ id: 'third', keywords: ['spam'], action: 'TIMEOUT', timeoutSeconds: 300 }),
      ]),
    });
    const hit = await svc.check({
      workspaceId: WS,
      channelId: CH,
      authorId: AUTHOR,
      actorRoleIds: [],
      contentPlain: 'spam',
    });
    expect(hit?.rule.id).toBe('second');
    expect(hit?.action).toBe('ALERT');
  });

  it('carries timeoutSeconds for TIMEOUT rules', async () => {
    const { svc } = makeService({
      findMany: vi.fn(async () => [
        ruleRow({ keywords: ['spam'], action: 'TIMEOUT', timeoutSeconds: 600 }),
      ]),
    });
    const hit = await svc.check({
      workspaceId: WS,
      channelId: CH,
      authorId: AUTHOR,
      actorRoleIds: [],
      contentPlain: 'spam',
    });
    expect(hit?.action).toBe('TIMEOUT');
    expect(hit?.timeoutSeconds).toBe(600);
  });

  it('caches enabled rules and invalidates on CRUD', async () => {
    const findMany = vi.fn(async () => [ruleRow({ keywords: ['spam'] })]);
    const { svc } = makeService({ findMany });
    await svc.check({
      workspaceId: WS,
      channelId: CH,
      authorId: AUTHOR,
      actorRoleIds: [],
      contentPlain: 'spam',
    });
    await svc.check({
      workspaceId: WS,
      channelId: CH,
      authorId: AUTHOR,
      actorRoleIds: [],
      contentPlain: 'spam again',
    });
    // 두 번째 호출은 캐시 적중 — findMany 는 1회만.
    expect(findMany).toHaveBeenCalledTimes(1);
    svc.invalidate(WS);
    await svc.check({
      workspaceId: WS,
      channelId: CH,
      authorId: AUTHOR,
      actorRoleIds: [],
      contentPlain: 'spam yet again',
    });
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  // ★리뷰 F1 (보안): AutoMod 집행은 OWNER/ADMIN 작성자에게 적용하지 않는다(모더레이터 면제).
  it.each(['OWNER', 'ADMIN'] as const)(
    'exempts %s authors from enforcement (actorRole passed) without loading rules',
    async (role) => {
      const { svc, findMany, memberFindUnique } = makeService({
        findMany: vi.fn(async () => [ruleRow({ keywords: ['spam'] })]),
      });
      const hit = await svc.check({
        workspaceId: WS,
        channelId: CH,
        authorId: AUTHOR,
        actorRoleIds: [],
        contentPlain: 'this is spam',
        actorRole: role,
      });
      expect(hit).toBeNull();
      // actorRole 이 면제이면 규칙 로드/멤버 조회 자체를 건너뛴다(hot-path).
      expect(findMany).not.toHaveBeenCalled();
      expect(memberFindUnique).not.toHaveBeenCalled();
    },
  );

  it('still enforces against MEMBER authors (actorRole passed)', async () => {
    const { svc } = makeService({
      findMany: vi.fn(async () => [ruleRow({ keywords: ['spam'] })]),
    });
    const hit = await svc.check({
      workspaceId: WS,
      channelId: CH,
      authorId: AUTHOR,
      actorRoleIds: [],
      contentPlain: 'this is spam',
      actorRole: 'MEMBER',
    });
    expect(hit?.action).toBe('BLOCK');
  });

  it('falls back to a membership lookup when actorRole is omitted and exempts an ADMIN', async () => {
    const memberFindUnique = vi.fn(async () => ({ role: 'ADMIN' }));
    const { svc, findMany } = makeService({
      findMany: vi.fn(async () => [ruleRow({ keywords: ['spam'] })]),
      memberFindUnique,
    });
    const hit = await svc.check({
      workspaceId: WS,
      channelId: CH,
      authorId: AUTHOR,
      actorRoleIds: [],
      contentPlain: 'this is spam',
      // actorRole 미지정 → 서비스가 작성자 멤버십을 조회해 ADMIN 면제 판정.
    });
    expect(hit).toBeNull();
    expect(memberFindUnique).toHaveBeenCalledTimes(1);
    expect(findMany).not.toHaveBeenCalled();
  });

  // ★리뷰 F4 (한국어 정확성): WORD 경계가 유니코드 — 한국어/CJK 키워드가 더 큰 단어 안에서
  // SUBSTRING 으로 degrade 하지 않는다('욕설' WORD 룰이 '욕설쟁이' 를 매칭하면 과차단).
  it('WORD mode does not match a Korean keyword inside a larger Korean word', async () => {
    const { svc } = makeService({
      findMany: vi.fn(async () => [ruleRow({ keywords: ['욕설'], matchMode: 'WORD' })]),
    });
    const hit = await svc.check({
      workspaceId: WS,
      channelId: CH,
      authorId: AUTHOR,
      actorRoleIds: [],
      contentPlain: '저 사람은 욕설쟁이야',
      actorRole: 'MEMBER',
    });
    expect(hit).toBeNull();
  });

  it('WORD mode matches a standalone Korean keyword (space/punctuation boundary)', async () => {
    const { svc } = makeService({
      findMany: vi.fn(async () => [ruleRow({ keywords: ['욕설'], matchMode: 'WORD' })]),
    });
    const hit = await svc.check({
      workspaceId: WS,
      channelId: CH,
      authorId: AUTHOR,
      actorRoleIds: [],
      contentPlain: '그건 욕설 입니다.',
      actorRole: 'MEMBER',
    });
    expect(hit?.keyword).toBe('욕설');
  });
});

describe('AutoModService CRUD', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  });

  it('create normalizes keywords (lowercase + dedupe) and records an audit', async () => {
    const create = vi.fn(async (args: { data: { keywords: string[] } }) =>
      ruleRow({ keywords: args.data.keywords }),
    );
    const { svc, auditRecord } = makeService({ create });
    await svc.create(WS, AUTHOR, {
      name: 'rule',
      triggerType: 'KEYWORD',
      keywords: ['  SPAM ', 'spam', 'Bad'],
      matchMode: 'SUBSTRING',
      action: 'BLOCK',
    });
    const passed = create.mock.calls[0][0].data.keywords;
    expect(passed).toEqual(['spam', 'bad']);
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.AUTOMOD_RULE_CREATE }),
      expect.anything(),
    );
  });

  it('create rejects when the per-workspace rule cap is reached', async () => {
    const { svc } = makeService({ count: vi.fn(async () => 100) });
    await expect(
      svc.create(WS, AUTHOR, {
        name: 'rule',
        triggerType: 'KEYWORD',
        keywords: ['spam'],
        matchMode: 'SUBSTRING',
        action: 'BLOCK',
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it('update on a missing/other-workspace rule throws NOT_FOUND', async () => {
    const { svc } = makeService({ findFirst: vi.fn(async () => null) });
    await expect(svc.update(WS, AUTHOR, RULE, { enabled: false })).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
  });

  it('update clears timeoutSeconds when action switches away from TIMEOUT', async () => {
    const update = vi.fn(async (_args: { data: { timeoutSeconds?: number | null } }) =>
      ruleRow({}),
    );
    const { svc } = makeService({ update });
    await svc.update(WS, AUTHOR, RULE, { action: 'BLOCK' });
    expect(update.mock.calls[0][0].data.timeoutSeconds).toBeNull();
  });

  // ★리뷰 F3 (보안): exempt 역할/채널은 모두 본 워크스페이스 소속이어야 한다.
  it('create rejects exemptRoleIds that are not in the workspace (400 VALIDATION_FAILED)', async () => {
    // role.findMany 가 빈 배열 → 요청한 id 가 워크스페이스에 없음.
    const { svc } = makeService({ roleFindMany: vi.fn(async () => []) });
    await expect(
      svc.create(WS, AUTHOR, {
        name: 'rule',
        triggerType: 'KEYWORD',
        keywords: ['spam'],
        matchMode: 'SUBSTRING',
        action: 'BLOCK',
        exemptRoleIds: [ROLE_A],
      }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
  });

  it('create rejects exemptChannelIds that are not in the workspace (400)', async () => {
    const { svc } = makeService({ channelFindMany: vi.fn(async () => []) });
    await expect(
      svc.create(WS, AUTHOR, {
        name: 'rule',
        triggerType: 'KEYWORD',
        keywords: ['spam'],
        matchMode: 'SUBSTRING',
        action: 'BLOCK',
        exemptChannelIds: [CH],
      }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
  });

  it('create accepts exempt ids that all belong to the workspace', async () => {
    const { svc, create } = makeService();
    await svc.create(WS, AUTHOR, {
      name: 'rule',
      triggerType: 'KEYWORD',
      keywords: ['spam'],
      matchMode: 'SUBSTRING',
      action: 'BLOCK',
      exemptRoleIds: [ROLE_A],
      exemptChannelIds: [CH],
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('update rejects exemptRoleIds not in the workspace (400)', async () => {
    const { svc } = makeService({ roleFindMany: vi.fn(async () => []) });
    await expect(svc.update(WS, AUTHOR, RULE, { exemptRoleIds: [ROLE_A] })).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_FAILED,
    });
  });

  it('remove records an audit and throws NOT_FOUND when nothing deleted', async () => {
    const { svc, auditRecord } = makeService();
    await svc.remove(WS, AUTHOR, RULE);
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.AUTOMOD_RULE_DELETE }),
      expect.anything(),
    );

    const missing = makeService({ deleteMany: vi.fn(async () => ({ count: 0 })) });
    await expect(missing.svc.remove(WS, AUTHOR, RULE)).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
  });
});
