/**
 * FR-RM10b (069) AutoMod 정규식 KEYWORD + MENTION_SPAM / REPEAT_SPAM 통합 검증 —
 * 실 Postgres + Redis(testcontainer).
 *
 * 검증 범위:
 *  - REGEX 룰 CRUD: 안전 정규식 생성(201) · 위험 정규식(catastrophic) 저장 시 400 REGEX_UNSAFE
 *    · 컴파일 불가 정규식 400 REGEX_UNSAFE.
 *  - REGEX 매칭: 패턴에 매칭되는 본문 BLOCK(422 AUTOMOD_BLOCKED) · 매칭 안 되는 본문 통과(201).
 *  - MENTION_SPAM: 윈도 내 누적 멘션 ≥ threshold → 액션(422) · 미만 통과(201).
 *  - REPEAT_SPAM: 윈도 내 동일 본문 반복 ≥ threshold → 액션(422) · 미만 통과(201).
 *  - OWNER/ADMIN 면제(모더레이터) · exemptRole 면제가 spam 트리거에도 적용.
 *
 * ★worker_threads: REGEX 매칭/검증은 dist(.js)·개발(.ts) resolve 후 worker 격리. int 는
 * 실제 worker 를 띄운다(vitest 가 src/.ts 를 직접 실행해 worker 파일이 .ts 로 존재 →
 * resolve 가능, 또는 fail-open). worker 타임아웃(10ms 워치독 강제 종료)은 unit(모킹)에서 검증.
 *
 * 단일 파일 실행(OOM 회피): pnpm --filter @qufox/api test:int -- frrm10b-automod
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

async function editMessage(
  msgId: string,
  content: string,
  token: string,
  expectedVersion: number,
  channelId = stack.channelId,
) {
  // PATCH 는 낙관잠금 expectedVersion 필수(FR-MSG-06 · UpdateMessageRequestSchema). 미동봉 시
  // MESSAGE_CONTENT_INVALID(422)가 AutoMod 검사보다 먼저 발생하므로 호출부가 현재 version 을 넘긴다.
  return request(env.baseUrl)
    .patch(`/workspaces/${stack.workspaceId}/channels/${channelId}/messages/${msgId}`)
    .set('origin', ORIGIN)
    .set(bearer(token))
    .send({ content, expectedVersion });
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
  await env.prisma.workspaceMember.updateMany({
    where: { workspaceId: stack.workspaceId },
    data: { mutedUntil: null },
  });
  await env.prisma.memberRole.deleteMany({
    where: { workspaceId: stack.workspaceId, role: { isSystem: false } },
  });
  await env.prisma.role.deleteMany({ where: { workspaceId: stack.workspaceId, isSystem: false } });
  const rlKeys = await env.redis.keys('qufox:rl:*');
  if (rlKeys.length > 0) await env.redis.del(...rlKeys.map((k) => k.replace(/^qufox:/, '')));
  // FR-RM10b: spam 윈도 키 초기화(테스트 간 누수 방지).
  const spamKeys = await env.redis.keys('automod:*spam:*');
  if (spamKeys.length > 0) await env.redis.del(...spamKeys);
});

describe('FR-RM10b REGEX KEYWORD rules', () => {
  it('creates a safe REGEX rule (201)', async () => {
    const res = await createRule({
      name: 'safe-regex',
      triggerType: 'KEYWORD',
      keywords: ['https?://evil\\.example', 'spam\\d+'],
      matchMode: 'REGEX',
      action: 'BLOCK',
    });
    expect(res.status).toBe(201);
    expect(res.body.matchMode).toBe('REGEX');
    // REGEX 패턴은 소문자화하지 않고 원문 보존(대소문자 의미).
    expect(res.body.keywords).toContain('https?://evil\\.example');
  });

  it('rejects a catastrophic (ReDoS) REGEX rule → 400 REGEX_UNSAFE', async () => {
    // ★(a+)+$ 는 multi-class probe('a'×22)에 ~934ms backtracking — 100ms 워치독을 확실히 초과해
    // unsafe(REGEX_UNSAFE) 판정된다(좀비 ~1s bounded). 약한 Fibonacci 패턴 (a|aa)+$ 는 bounded
    // probe 에선 100ms 미달이라 저장 통과 후 match-time fail-open 으로 무력화(문서화된 한계·carryover).
    const res = await createRule({
      name: 'redos-regex',
      triggerType: 'KEYWORD',
      keywords: ['(a+)+$'],
      matchMode: 'REGEX',
      action: 'BLOCK',
    });
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe('REGEX_UNSAFE');
  });

  it('rejects an uncompilable REGEX rule → 400 REGEX_UNSAFE', async () => {
    const res = await createRule({
      name: 'bad-regex',
      triggerType: 'KEYWORD',
      keywords: ['(unclosed'],
      matchMode: 'REGEX',
      action: 'BLOCK',
    });
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe('REGEX_UNSAFE');
  });

  // ★HIGH (069 fix-forward · probe false-negative): 비-'a' 클래스로 폭발하는 catastrophic 패턴.
  // 종전 단일 'a'×N probe 는 이들을 통과(0ms)시켜 저장 → match 시 fail-open 으로 룰 무력화했다.
  // 다문자 probe 세트(영문 소/대문자·숫자·공백 run)로 이제 전부 REGEX_UNSAFE(400) 로 거부한다.
  it('★HIGH: rejects non-"a" catastrophic regex via multi-char probes (REGEX_UNSAFE)', async () => {
    for (const pattern of ['(\\d+)+$', '(b+)+$', '([A-Z]+)*$']) {
      const res = await createRule({
        name: `redos-${pattern.replace(/\W/g, '')}`,
        triggerType: 'KEYWORD',
        keywords: [pattern],
        matchMode: 'REGEX',
        action: 'BLOCK',
      });
      expect(res.status).toBe(400);
      expect(res.body.errorCode).toBe('REGEX_UNSAFE');
    }
  });

  // ★BLOCKER (069 fix-forward): 위험 패턴을 ★연속 반복 저장해도 API 가 정지(이벤트루프 stall)하지
  // 않는다 — 워치독 terminate 경로가 메인스레드에서 catastrophic 정규식을 동기 재실행하지 않음을
  // 간접 검증한다(재실행 시 매 저장 시도마다 메인 루프가 수초 stall → 누적되면 후속 요청 hang).
  it('★BLOCKER: repeated catastrophic saves stay responsive (no main-thread re-exec)', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await createRule({
        name: `redos-repeat-${i}`,
        triggerType: 'KEYWORD',
        keywords: ['(a+)+$'],
        matchMode: 'REGEX',
        action: 'BLOCK',
      });
      expect(res.status).toBe(400);
      expect(res.body.errorCode).toBe('REGEX_UNSAFE');
    }
    // 위험 저장 직후에도 정상 요청이 즉시 처리된다(메인 루프 무stall).
    const safe = await createRule({
      name: 'safe-after-redos',
      triggerType: 'KEYWORD',
      keywords: ['^[a-z]+$'],
      matchMode: 'REGEX',
      action: 'BLOCK',
    });
    expect(safe.status).toBe(201);
  });

  it('REGEX BLOCK: message matching the pattern is rejected (422), non-matching passes', async () => {
    await createRule({
      name: 'regex-block',
      triggerType: 'KEYWORD',
      // 숫자 4자리 이상 시퀀스(스팸 코드 등) 매칭.
      keywords: ['\\d{4,}'],
      matchMode: 'REGEX',
      action: 'BLOCK',
    });
    const blocked = await sendMessage('order code 123456 now', stack.member.accessToken);
    expect(blocked.status).toBe(422);
    expect(blocked.body.errorCode).toBe('AUTOMOD_BLOCKED');

    const ok = await sendMessage('no digits here at all', stack.member.accessToken);
    expect(ok.status).toBe(201);
  });

  it('REGEX rule does not enforce against an ADMIN author (moderator exempt)', async () => {
    await createRule({
      name: 'regex-admin-exempt',
      triggerType: 'KEYWORD',
      keywords: ['\\d{4,}'],
      matchMode: 'REGEX',
      action: 'BLOCK',
    });
    const adminRes = await sendMessage('admin code 999999', stack.admin.accessToken);
    expect(adminRes.status).toBe(201);
    const memberRes = await sendMessage('member code 999999', stack.member.accessToken);
    expect(memberRes.status).toBe(422);
  });
});

describe('FR-RM10b MENTION_SPAM', () => {
  it('blocks once accumulated mentions reach the threshold; passes below it', async () => {
    await createRule({
      name: 'mention-spam',
      triggerType: 'MENTION_SPAM',
      mentionThreshold: 3,
      windowSeconds: 60,
      action: 'BLOCK',
    });
    // 각 메시지 1 멘션(@admin). 1·2번째 누적(1,2) 통과, 3번째(누적 3) 차단.
    const m1 = await sendMessage(`hi @${stack.admin.username}`, stack.member.accessToken);
    expect(m1.status).toBe(201);
    const m2 = await sendMessage(`yo @${stack.admin.username}`, stack.member.accessToken);
    expect(m2.status).toBe(201);
    const m3 = await sendMessage(`hey @${stack.admin.username}`, stack.member.accessToken);
    expect(m3.status).toBe(422);
    expect(m3.body.errorCode).toBe('AUTOMOD_BLOCKED');
  });

  it('does not enforce MENTION_SPAM against an ADMIN author (moderator exempt)', async () => {
    await createRule({
      name: 'mention-spam-admin',
      triggerType: 'MENTION_SPAM',
      mentionThreshold: 1,
      windowSeconds: 60,
      action: 'BLOCK',
    });
    // ADMIN 작성자는 threshold=1 이어도 면제.
    const res = await sendMessage(`ping @${stack.member.username}`, stack.admin.accessToken);
    expect(res.status).toBe(201);
  });
});

describe('FR-RM10b REPEAT_SPAM', () => {
  it('blocks once the same content repeats to the threshold; different content passes', async () => {
    await createRule({
      name: 'repeat-spam',
      triggerType: 'REPEAT_SPAM',
      repeatThreshold: 3,
      windowSeconds: 60,
      action: 'BLOCK',
    });
    expect((await sendMessage('buy now cheap', stack.member.accessToken)).status).toBe(201);
    expect((await sendMessage('buy now cheap', stack.member.accessToken)).status).toBe(201);
    // 3번째 동일 본문 → 차단.
    const third = await sendMessage('buy now cheap', stack.member.accessToken);
    expect(third.status).toBe(422);
    expect(third.body.errorCode).toBe('AUTOMOD_BLOCKED');
    // 다른 본문은 별도 해시라 통과.
    expect((await sendMessage('a unique message', stack.member.accessToken)).status).toBe(201);
  });

  // ★MED-1 (069 fix-forward): 편집 경로는 spam record/count 를 스킵한다. 같은 메시지를 N회 편집해도
  // REPEAT_SPAM 이 발화하지 않아야 한다(편집 반복으로 inflate 되어 정상 사용자가 차단되던 회귀 차단).
  it('★MED-1: repeated edits of one message do NOT trigger REPEAT_SPAM', async () => {
    await createRule({
      name: 'repeat-spam-edit',
      triggerType: 'REPEAT_SPAM',
      repeatThreshold: 2,
      windowSeconds: 60,
      action: 'BLOCK',
    });
    // 최초 send 1회(repeatThreshold=2 미만이라 통과).
    const sent = await sendMessage('edit me repeatedly', stack.member.accessToken);
    expect(sent.status).toBe(201);
    const msgId = sent.body.message.id as string;
    let version = sent.body.message.version as number;
    // 같은 본문으로 여러 번 편집해도 spam record 가 일어나지 않아 차단되지 않는다(낙관잠금 version 추적).
    for (let i = 0; i < 4; i++) {
      const edited = await editMessage(
        msgId,
        `edited content v${i}`,
        stack.member.accessToken,
        version,
      );
      expect(edited.status).toBe(200);
      version = edited.body.message.version as number;
    }
    // 'edited content v0' 를 다시 편집(반복 본문) — 편집은 spam 트리거를 평가하지 않으므로 통과.
    // (recordSpam=false 가 안 먹으면 v0 가 2회로 repeatThreshold=2 도달해 422 가 됐을 것.)
    const again = await editMessage(msgId, 'edited content v0', stack.member.accessToken, version);
    expect(again.status).toBe(200);
  });

  // ★MED-1: 편집 경로도 KEYWORD/REGEX 집행은 유지한다(평문→금칙어 편집 우회 차단).
  it('★MED-1: edit STILL enforces KEYWORD rules (bypass guard kept)', async () => {
    await createRule({
      name: 'keyword-edit-guard',
      triggerType: 'KEYWORD',
      keywords: ['forbidden'],
      matchMode: 'SUBSTRING',
      action: 'BLOCK',
    });
    const sent = await sendMessage('a clean message', stack.member.accessToken);
    expect(sent.status).toBe(201);
    const msgId = sent.body.message.id as string;
    const version = sent.body.message.version as number;
    // 편집으로 금칙어를 주입하면 거부(편집 우회 차단).
    const edited = await editMessage(
      msgId,
      'now forbidden word',
      stack.member.accessToken,
      version,
    );
    expect(edited.status).toBe(422);
    expect(edited.body.errorCode).toBe('AUTOMOD_BLOCKED');
  });

  it('exempt role: author holding the exempt role bypasses REPEAT_SPAM', async () => {
    await ensureSecondMember();
    const roleId = await createRole('RepeatExempt');
    await assignRole(roleId, stack.member.userId);
    await createRule({
      name: 'repeat-spam-exempt',
      triggerType: 'REPEAT_SPAM',
      repeatThreshold: 2,
      windowSeconds: 60,
      action: 'BLOCK',
      exemptRoleIds: [roleId],
    });
    // 면제 역할 보유 member 는 동일 본문 반복해도 통과.
    expect((await sendMessage('spammy line', stack.member.accessToken)).status).toBe(201);
    expect((await sendMessage('spammy line', stack.member.accessToken)).status).toBe(201);
    expect((await sendMessage('spammy line', stack.member.accessToken)).status).toBe(201);
  });
});
