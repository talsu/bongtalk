/**
 * Task-013-B / S39 (D05): MessageReaction API. Covers:
 *   - POST add → toggle: 두 번째 동일 POST 는 제거(toggle), 둘 다 200
 *   - DELETE own emoji → no-op delete is still 204
 *   - GET list/getOne exposes `reactions: [{ emoji, count, byMe }]`
 *   - GET /messages/:id/reactions 가 emoji별 users[≤5] 를 반환(FR-RE04)
 *   - FR-RE02: 고유 이모지 20종 한도 — 21번째 종류는 409 REACTION_LIMIT_REACHED
 *   - codepoint cap (>4) rejected with VALIDATION_FAILED
 *   - FR-RE06: 삭제 메시지 반응 → 404
 *   - non-member (no READ) gets 403 via ChannelAccessByIdGuard
 *   - outbox `message.reaction.updated` 단일 이벤트 발행(옵션 B)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { MsgIntEnv, bearer, seedMessageStack, setupMsgIntEnv } from '../messages/helpers';

let env: MsgIntEnv;
let stack: Awaited<ReturnType<typeof seedMessageStack>>;

beforeAll(async () => {
  env = await setupMsgIntEnv();
  stack = await seedMessageStack(env.baseUrl);
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

beforeEach(async () => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  await env.prisma.messageReaction.deleteMany({});
  await env.prisma.message.deleteMany({ where: { channelId: stack.channelId } });
  await env.prisma.outboxEvent.deleteMany({});
  const rlKeys = await env.redis.keys('rl:*');
  if (rlKeys.length > 0) await env.redis.del(...rlKeys);
});

async function postMessage(token: string, content = 'reactable'): Promise<string> {
  const r = await request(env.baseUrl)
    .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
    .set(bearer(token))
    .send({ content });
  if (r.status !== 201) throw new Error(`post: ${r.status} ${r.text}`);
  return r.body.message.id as string;
}

// FR-RE02 한도 테스트용 고유 이모지 종류(코드포인트 ≤4) 풀.
const EMOJI_POOL = [
  '👍',
  '👎',
  '🎉',
  '🔥',
  '❤',
  '😀',
  '😁',
  '😂',
  '🤣',
  '😊',
  '😍',
  '😎',
  '🤔',
  '😢',
  '😡',
  '👏',
  '🙏',
  '💯',
  '✨',
  '⭐',
  '🚀',
  '🎊',
  '🥳',
  '😇',
];

describe('Reactions API (task-013-B / S39 toggle)', () => {
  it('FR-RE01: POST toggles add↔remove via a single endpoint, always 200', async () => {
    const msgId = await postMessage(stack.member.accessToken);

    // 1st POST → add. 200 + 집계.
    const a1 = await request(env.baseUrl)
      .post(`/messages/${msgId}/reactions`)
      .set(bearer(stack.member.accessToken))
      .send({ emoji: '👍' });
    expect(a1.status).toBe(200);
    expect(a1.body).toMatchObject({ emoji: '👍', count: 1, byMe: true });

    // 2nd identical POST → toggle off (remove). 200 + count 0 / byMe false.
    const a2 = await request(env.baseUrl)
      .post(`/messages/${msgId}/reactions`)
      .set(bearer(stack.member.accessToken))
      .send({ emoji: '👍' });
    expect(a2.status).toBe(200);
    expect(a2.body).toMatchObject({ emoji: '👍', count: 0, byMe: false });

    // 3rd POST → add again.
    const a3 = await request(env.baseUrl)
      .post(`/messages/${msgId}/reactions`)
      .set(bearer(stack.member.accessToken))
      .send({ emoji: '👍' });
    expect(a3.status).toBe(200);
    expect(a3.body.count).toBe(1);

    const list = await request(env.baseUrl)
      .get(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set(bearer(stack.member.accessToken));
    expect(list.status).toBe(200);
    const found = list.body.items.find((m: { id: string }) => m.id === msgId);
    expect(found.reactions).toEqual([{ emoji: '👍', count: 1, byMe: true }]);

    // admin viewing — byMe must be false since admin hasn't reacted.
    const listAdmin = await request(env.baseUrl)
      .get(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set(bearer(stack.admin.accessToken));
    const adminView = listAdmin.body.items.find((m: { id: string }) => m.id === msgId);
    expect(adminView.reactions).toEqual([{ emoji: '👍', count: 1, byMe: false }]);
  });

  it('DELETE own reaction → 204, row gone', async () => {
    const msgId = await postMessage(stack.member.accessToken);
    await request(env.baseUrl)
      .post(`/messages/${msgId}/reactions`)
      .set(bearer(stack.member.accessToken))
      .send({ emoji: '🎉' })
      .expect(200);

    const del = await request(env.baseUrl)
      .delete(`/messages/${msgId}/reactions/${encodeURIComponent('🎉')}`)
      .set(bearer(stack.member.accessToken));
    expect(del.status).toBe(204);

    // Second delete is a silent no-op (still 204) so the UI can be optimistic.
    const del2 = await request(env.baseUrl)
      .delete(`/messages/${msgId}/reactions/${encodeURIComponent('🎉')}`)
      .set(bearer(stack.member.accessToken));
    expect(del2.status).toBe(204);

    const one = await request(env.baseUrl)
      .get(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages/${msgId}`)
      .set(bearer(stack.member.accessToken));
    expect(one.body.message.reactions).toEqual([]);
  });

  it('FR-RE04: GET /messages/:id/reactions returns emoji groups with users[≤5]', async () => {
    const msgId = await postMessage(stack.member.accessToken);
    for (const a of [stack.member, stack.admin, stack.owner]) {
      await request(env.baseUrl)
        .post(`/messages/${msgId}/reactions`)
        .set(bearer(a.accessToken))
        .send({ emoji: '🚀' })
        .expect(200);
    }
    const r = await request(env.baseUrl)
      .get(`/messages/${msgId}/reactions`)
      .set(bearer(stack.member.accessToken));
    expect(r.status).toBe(200);
    expect(r.body.reactions).toHaveLength(1);
    const bucket = r.body.reactions[0];
    expect(bucket.emoji).toBe('🚀');
    expect(bucket.count).toBe(3);
    expect(bucket.users).toHaveLength(3);
    const ids = bucket.users.map((u: { id: string }) => u.id).sort();
    expect(ids).toEqual([stack.member.userId, stack.admin.userId, stack.owner.userId].sort());
    // username 이 포함된다(아바타 스택 라벨).
    expect(
      bucket.users.every((u: { username: string | null }) => typeof u.username === 'string'),
    ).toBe(true);
  });

  it('FR-RE02: 21번째 고유 이모지 종류는 409 REACTION_LIMIT_REACHED', async () => {
    const msgId = await postMessage(stack.member.accessToken);
    // 20종을 채운다(서로 다른 사용자가 섞여도 종류는 메시지 단위 집계).
    for (let i = 0; i < 20; i++) {
      await request(env.baseUrl)
        .post(`/messages/${msgId}/reactions`)
        .set(bearer(stack.member.accessToken))
        .send({ emoji: EMOJI_POOL[i] })
        .expect(200);
    }
    // 21번째 새 종류 → 409.
    const over = await request(env.baseUrl)
      .post(`/messages/${msgId}/reactions`)
      .set(bearer(stack.member.accessToken))
      .send({ emoji: EMOJI_POOL[20] });
    expect(over.status).toBe(409);
    expect(over.body.errorCode).toBe('REACTION_LIMIT_REACHED');
    // 거부된 종류의 행은 롤백되어 남아있지 않다(20종 유지).
    const kinds = await env.prisma.messageReaction.findMany({
      where: { messageId: msgId },
      select: { emoji: true },
    });
    expect(new Set(kinds.map((k) => k.emoji)).size).toBe(20);

    // 이미 존재하는 이모지를 다른 사용자가 추가하는 것은 신규 종류가 아니므로
    // 한도와 무관하게 허용된다(여전히 200, 종류 20 유지).
    const dup = await request(env.baseUrl)
      .post(`/messages/${msgId}/reactions`)
      .set(bearer(stack.admin.accessToken))
      .send({ emoji: EMOJI_POOL[0] });
    expect(dup.status).toBe(200);
    expect(dup.body.count).toBe(2);
  });

  it('FR-RE02: 동시 21종 INSERT 중 정확히 1개만 409 (ON CONFLICT + COUNT FOR UPDATE)', async () => {
    const msgId = await postMessage(stack.member.accessToken);
    // 21개의 서로 다른 종류를 동시에 추가 시도 → FOR UPDATE 직렬화로 정확히
    // 20종만 성공하고 나머지는 409.
    const results = await Promise.all(
      EMOJI_POOL.slice(0, 21).map((emoji) =>
        request(env.baseUrl)
          .post(`/messages/${msgId}/reactions`)
          .set(bearer(stack.member.accessToken))
          .send({ emoji }),
      ),
    );
    const ok = results.filter((r) => r.status === 200).length;
    const limited = results.filter((r) => r.status === 409).length;
    expect(ok).toBe(20);
    expect(limited).toBe(1);
    const kinds = await env.prisma.messageReaction.findMany({
      where: { messageId: msgId },
      select: { emoji: true },
    });
    expect(new Set(kinds.map((k) => k.emoji)).size).toBe(20);
  });

  it('rejects emoji >4 codepoints with VALIDATION_FAILED', async () => {
    const msgId = await postMessage(stack.member.accessToken);
    const tooLong = '👍👎🎉🔥❤️'; // 5 codepoints
    const r = await request(env.baseUrl)
      .post(`/messages/${msgId}/reactions`)
      .set(bearer(stack.member.accessToken))
      .send({ emoji: tooLong });
    // VALIDATION_FAILED → 400 (ERROR_CODE_HTTP_STATUS 매핑).
    expect(r.status).toBe(400);
    expect(r.body.errorCode).toBe('VALIDATION_FAILED');
  });

  it('FR-RE06: 삭제된 메시지에 반응 추가 → 404', async () => {
    const msgId = await postMessage(stack.member.accessToken);
    // soft-delete 한다.
    await request(env.baseUrl)
      .delete(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages/${msgId}`)
      .set(bearer(stack.member.accessToken))
      .expect(204);
    const r = await request(env.baseUrl)
      .post(`/messages/${msgId}/reactions`)
      .set(bearer(stack.member.accessToken))
      .send({ emoji: '👍' });
    expect(r.status).toBe(404);
    expect(r.body.errorCode).toBe('MESSAGE_NOT_FOUND');
  });

  it('non-member is rejected by ChannelAccessByIdGuard (403/404 — 비노출 마스킹)', async () => {
    const msgId = await postMessage(stack.member.accessToken);
    const r = await request(env.baseUrl)
      .post(`/messages/${msgId}/reactions`)
      .set(bearer(stack.nonMember.accessToken))
      .send({ emoji: '👍' });
    // 비멤버는 권한 거부(403) 또는 워크스페이스 비노출 마스킹(404, WORKSPACE_NOT_MEMBER)
    // 으로 거부된다 — 어느 쪽이든 반응 추가는 불가하다.
    expect([401, 403, 404]).toContain(r.status);
  });

  it('FR-RE03: add/remove each emit a single message.reaction.updated outbox event', async () => {
    const msgId = await postMessage(stack.member.accessToken);
    await request(env.baseUrl)
      .post(`/messages/${msgId}/reactions`)
      .set(bearer(stack.member.accessToken))
      .send({ emoji: '✨' })
      .expect(200);
    await request(env.baseUrl)
      .delete(`/messages/${msgId}/reactions/${encodeURIComponent('✨')}`)
      .set(bearer(stack.member.accessToken))
      .expect(204);

    const events = await env.prisma.outboxEvent.findMany({
      where: { aggregateId: msgId, eventType: { startsWith: 'message.reaction.' } },
      orderBy: { occurredAt: 'asc' },
    });
    // 옵션 B: add 1건 + remove 1건, 둘 다 .updated 단일 종류.
    expect(events.map((e) => e.eventType)).toEqual([
      'message.reaction.updated',
      'message.reaction.updated',
    ]);
    // payload carries channelId + messageId for the subscriber's room routing
    // + re-aggregation.
    expect((events[0].payload as { channelId: string }).channelId).toBe(stack.channelId);
    expect((events[0].payload as { messageId: string }).messageId).toBe(msgId);
  });

  it('multiple users on the same emoji sum in count, distinct byMe', async () => {
    const msgId = await postMessage(stack.member.accessToken);
    for (const a of [stack.member, stack.admin, stack.owner]) {
      await request(env.baseUrl)
        .post(`/messages/${msgId}/reactions`)
        .set(bearer(a.accessToken))
        .send({ emoji: '🚀' })
        .expect(200);
    }
    const one = await request(env.baseUrl)
      .get(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages/${msgId}`)
      .set(bearer(stack.member.accessToken));
    expect(one.body.message.reactions).toEqual([{ emoji: '🚀', count: 3, byMe: true }]);
  });
});
