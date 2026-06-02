/**
 * S52 (D10 / FR-PS-08 + FR-PS-13) 개인 저장함 탭 이동 + bulk 채움 상태 통합 검증 —
 * 실 Postgres + Redis(testcontainer). 마이그레이션 없음(S51 SavedMessage 테이블 재사용).
 *
 * 커버리지:
 *   FR-PS-08 — PATCH /me/saved/:savedMessageId 임의 전이(IN_PROGRESS→ARCHIVED→
 *              COMPLETED→IN_PROGRESS) · 타인 항목 404 SAVED_NOT_FOUND · 잘못된 status
 *              400 VALIDATION_FAILED · 삭제된 원본 항목 PATCH 허용 · 500 한도 미적용 ·
 *              PATCH 후 IN_PROGRESS count 변화.
 *   FR-PS-13 — POST /me/saved/status-bulk 저장된 messageId 만 반환 · 어느 status 든
 *              포함 · 타인 저장 미노출 · 비가시/없는 id 결과 제외 · 빈 배열 처리 ·
 *              상한(200) 초과 400.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { MsgIntEnv, ORIGIN, bearer, seedMessageStack, setupMsgIntEnv } from './helpers';

let env: MsgIntEnv;
let stack: Awaited<ReturnType<typeof seedMessageStack>>;

const ws = () => stack.workspaceId;
const ch = () => stack.channelId;

async function sendMessage(token: string, content: string): Promise<string> {
  const res = await request(env.baseUrl)
    .post(`/workspaces/${ws()}/channels/${ch()}/messages`)
    .set('origin', ORIGIN)
    .set(bearer(token))
    .send({ content });
  if (res.status !== 201) throw new Error(`send failed: ${res.status} ${res.text}`);
  return res.body.message.id as string;
}

function saveMsg(token: string, msgId: string) {
  return request(env.baseUrl)
    .post(`/me/saved/${msgId}`)
    .set('origin', ORIGIN)
    .set(bearer(token))
    .send();
}

function patchSaved(token: string, savedMessageId: string, status: unknown) {
  return request(env.baseUrl)
    .patch(`/me/saved/${savedMessageId}`)
    .set('origin', ORIGIN)
    .set(bearer(token))
    .send({ status });
}

function statusBulk(token: string, messageIds: unknown) {
  return request(env.baseUrl)
    .post('/me/saved/status-bulk')
    .set('origin', ORIGIN)
    .set(bearer(token))
    .send({ messageIds });
}

function savedCount(token: string) {
  return request(env.baseUrl).get('/me/saved/count').set('origin', ORIGIN).set(bearer(token));
}

function deleteMsg(token: string, msgId: string) {
  return request(env.baseUrl)
    .delete(`/workspaces/${ws()}/channels/${ch()}/messages/${msgId}`)
    .set('origin', ORIGIN)
    .set(bearer(token))
    .send();
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
  await env.prisma.savedMessage.deleteMany({});
  await env.prisma.message.deleteMany({ where: { channelId: ch() } });
  await env.prisma.outboxEvent.deleteMany({});
});

describe('S52 FR-PS-08 — PATCH 탭(status) 이동', () => {
  it('임의 전이 IN_PROGRESS→ARCHIVED→COMPLETED→IN_PROGRESS 가 모두 허용된다', async () => {
    const msgId = await sendMessage(stack.member.accessToken, 'transition target');
    const saved = await saveMsg(stack.member.accessToken, msgId);
    expect(saved.body.status).toBe('IN_PROGRESS');
    const savedMessageId = saved.body.savedMessageId as string;

    const toArchived = await patchSaved(stack.member.accessToken, savedMessageId, 'ARCHIVED');
    expect(toArchived.status).toBe(200);
    expect(toArchived.body.status).toBe('ARCHIVED');
    expect(toArchived.body.id).toBe(savedMessageId);
    expect(toArchived.body.messageId).toBe(msgId);
    expect(toArchived.body.excerpt).toContain('transition target');

    const toCompleted = await patchSaved(stack.member.accessToken, savedMessageId, 'COMPLETED');
    expect(toCompleted.status).toBe(200);
    expect(toCompleted.body.status).toBe('COMPLETED');

    const backToProgress = await patchSaved(
      stack.member.accessToken,
      savedMessageId,
      'IN_PROGRESS',
    );
    expect(backToProgress.status).toBe(200);
    expect(backToProgress.body.status).toBe('IN_PROGRESS');

    // DB 권위 확인.
    const row = await env.prisma.savedMessage.findUnique({ where: { id: savedMessageId } });
    expect(row!.status).toBe('IN_PROGRESS');
  });

  it('타인 소유 항목 PATCH 는 404 SAVED_NOT_FOUND(IDOR 차단)', async () => {
    const msgId = await sendMessage(stack.member.accessToken, 'owned by member');
    const saved = await saveMsg(stack.member.accessToken, msgId);
    const savedMessageId = saved.body.savedMessageId as string;

    // admin(타 사용자)이 member 의 SavedMessage.id 로 PATCH 시도 → 404.
    const res = await patchSaved(stack.admin.accessToken, savedMessageId, 'ARCHIVED');
    expect(res.status).toBe(404);
    expect(res.body.errorCode).toBe('SAVED_NOT_FOUND');

    // member 항목 status 는 변하지 않았다.
    const row = await env.prisma.savedMessage.findUnique({ where: { id: savedMessageId } });
    expect(row!.status).toBe('IN_PROGRESS');
  });

  it('존재하지 않는 savedMessageId 는 404 SAVED_NOT_FOUND', async () => {
    const res = await patchSaved(
      stack.member.accessToken,
      '00000000-0000-0000-0000-000000000000',
      'ARCHIVED',
    );
    expect(res.status).toBe(404);
    expect(res.body.errorCode).toBe('SAVED_NOT_FOUND');
  });

  it('잘못된 status 값은 400 VALIDATION_FAILED', async () => {
    const msgId = await sendMessage(stack.member.accessToken, 'bad status target');
    const saved = await saveMsg(stack.member.accessToken, msgId);
    const savedMessageId = saved.body.savedMessageId as string;

    const res = await patchSaved(stack.member.accessToken, savedMessageId, 'NOPE');
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe('VALIDATION_FAILED');
  });

  it('삭제된 원본 항목도 PATCH(탭 이동)가 허용된다(FR-PS-12 잔존 액션)', async () => {
    const msgId = await sendMessage(stack.member.accessToken, 'will be deleted then moved');
    const saved = await saveMsg(stack.member.accessToken, msgId);
    const savedMessageId = saved.body.savedMessageId as string;
    // 작성자 본인이 원본 soft-delete → SavedMessage.messageDeletedAt 채워짐.
    expect((await deleteMsg(stack.member.accessToken, msgId)).status).toBe(204);
    const before = await env.prisma.savedMessage.findUnique({ where: { id: savedMessageId } });
    expect(before!.messageDeletedAt).not.toBeNull();

    // 삭제된 항목을 COMPLETED 로 이동 → 허용, excerpt 는 마스킹.
    const res = await patchSaved(stack.member.accessToken, savedMessageId, 'COMPLETED');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('COMPLETED');
    expect(res.body.messageDeletedAt).not.toBeNull();
    expect(res.body.excerpt).toBe('[삭제된 메시지]');
  });

  it('500 한도가 PATCH 에는 적용되지 않는다(기존 레코드 조작)', async () => {
    // 정확히 500개를 시드(한도 경계). PATCH 는 신규 레코드를 만들지 않으므로 허용돼야 한다.
    const now = new Date('2025-01-01T00:00:00.000Z').getTime();
    const msgRows = Array.from({ length: 500 }, (_, i) => ({
      id: crypto.randomUUID(),
      channelId: ch(),
      authorId: stack.member.userId,
      content: `bulk ${i}`,
      contentPlain: `bulk ${i}`,
      createdAt: new Date(now + i * 10),
    }));
    await env.prisma.message.createMany({ data: msgRows });
    await env.prisma.savedMessage.createMany({
      data: msgRows.map((m) => ({ userId: stack.member.userId, messageId: m.id })),
    });
    const target = await env.prisma.savedMessage.findFirst({
      where: { userId: stack.member.userId, messageId: msgRows[0].id },
    });
    const res = await patchSaved(stack.member.accessToken, target!.id, 'ARCHIVED');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ARCHIVED');
  });

  it('PATCH 로 IN_PROGRESS 를 벗어나면 count(IN_PROGRESS) 가 감소한다', async () => {
    const a = await sendMessage(stack.member.accessToken, 'count a');
    const b = await sendMessage(stack.member.accessToken, 'count b');
    const sa = await saveMsg(stack.member.accessToken, a);
    await saveMsg(stack.member.accessToken, b);
    expect((await savedCount(stack.member.accessToken)).body.count).toBe(2);

    // a 를 ARCHIVED 로 이동 → IN_PROGRESS count 1.
    await patchSaved(stack.member.accessToken, sa.body.savedMessageId, 'ARCHIVED');
    expect((await savedCount(stack.member.accessToken)).body.count).toBe(1);

    // 다시 IN_PROGRESS 로 복원 → count 2.
    await patchSaved(stack.member.accessToken, sa.body.savedMessageId, 'IN_PROGRESS');
    expect((await savedCount(stack.member.accessToken)).body.count).toBe(2);
  });
});

describe('S52 FR-PS-13 — POST /me/saved/status-bulk 채움 상태', () => {
  it('저장된 messageId 만 반환하고 어느 status 든 포함한다', async () => {
    const inProgress = await sendMessage(stack.member.accessToken, 'still in progress');
    const archived = await sendMessage(stack.member.accessToken, 'will archive');
    const completed = await sendMessage(stack.member.accessToken, 'will complete');
    const notSaved = await sendMessage(stack.member.accessToken, 'never saved');

    await saveMsg(stack.member.accessToken, inProgress);
    const sa = await saveMsg(stack.member.accessToken, archived);
    const sc = await saveMsg(stack.member.accessToken, completed);
    await patchSaved(stack.member.accessToken, sa.body.savedMessageId, 'ARCHIVED');
    await patchSaved(stack.member.accessToken, sc.body.savedMessageId, 'COMPLETED');

    const res = await statusBulk(stack.member.accessToken, [
      inProgress,
      archived,
      completed,
      notSaved,
    ]);
    expect(res.status).toBe(200);
    const saved = res.body.saved as string[];
    // 어느 status 든 채움(Slack parity) — 저장한 3건 모두 포함.
    expect(new Set(saved)).toEqual(new Set([inProgress, archived, completed]));
    // 저장하지 않은 메시지는 빠진다.
    expect(saved).not.toContain(notSaved);
  });

  it('타인이 저장한 메시지는 노출되지 않는다(본인 스코프)', async () => {
    const msgId = await sendMessage(stack.member.accessToken, 'saved only by member');
    await saveMsg(stack.member.accessToken, msgId);

    // admin 이 같은 messageId 로 bulk 조회 → admin 은 저장한 적 없으므로 빈 결과.
    const res = await statusBulk(stack.admin.accessToken, [msgId]);
    expect(res.status).toBe(200);
    expect(res.body.saved).toEqual([]);
  });

  it('존재하지 않는/비가시 messageId 는 단순히 결과에서 제외된다(누출 없음)', async () => {
    const saved = await sendMessage(stack.member.accessToken, 'real saved');
    await saveMsg(stack.member.accessToken, saved);
    const ghost = '00000000-0000-0000-0000-000000000000';

    const res = await statusBulk(stack.member.accessToken, [saved, ghost]);
    expect(res.status).toBe(200);
    expect(res.body.saved).toEqual([saved]);
  });

  it('빈 배열은 빈 saved 를 반환한다', async () => {
    const res = await statusBulk(stack.member.accessToken, []);
    expect(res.status).toBe(200);
    expect(res.body.saved).toEqual([]);
  });

  it('상한(200) 초과 배치는 400 VALIDATION_FAILED', async () => {
    const ids = Array.from({ length: 201 }, () => crypto.randomUUID());
    const res = await statusBulk(stack.member.accessToken, ids);
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe('VALIDATION_FAILED');
  });

  it('UUID 가 아닌 messageId 는 400 VALIDATION_FAILED', async () => {
    const res = await statusBulk(stack.member.accessToken, ['not-a-uuid']);
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe('VALIDATION_FAILED');
  });
});
