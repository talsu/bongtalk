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
  // 반응/메시지 rate-limit 버킷을 모두 비운다. 반응 엔드포인트는 60/min 고정 한도라,
  // 프로즌 클록(2025-01-01) 아래에서 같은 user 키가 테스트 간 누적되지 않도록
  // 전체 rl:* 를 매 테스트 시작 시 제거한다(기존 패턴 + FLUSH 보강).
  await env.redis.flushdb();
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

  it('security MEDIUM: 보관(archived) 채널의 반응은 POST/DELETE/GET 모두 409 CHANNEL_ARCHIVED', async () => {
    // 아직 보관 전 채널에 메시지 + 반응 1개를 만든 뒤 채널을 archive 한다.
    const msgId = await postMessage(stack.member.accessToken);
    await request(env.baseUrl)
      .post(`/messages/${msgId}/reactions`)
      .set(bearer(stack.member.accessToken))
      .send({ emoji: '👍' })
      .expect(200);

    await env.prisma.channel.update({
      where: { id: stack.channelId },
      data: { archivedAt: new Date() },
    });

    try {
      // POST(toggle) → 409.
      const post = await request(env.baseUrl)
        .post(`/messages/${msgId}/reactions`)
        .set(bearer(stack.member.accessToken))
        .send({ emoji: '🎉' });
      expect(post.status).toBe(409);
      expect(post.body.errorCode).toBe('CHANNEL_ARCHIVED');

      // DELETE → 409.
      const del = await request(env.baseUrl)
        .delete(`/messages/${msgId}/reactions/${encodeURIComponent('👍')}`)
        .set(bearer(stack.member.accessToken));
      expect(del.status).toBe(409);
      expect(del.body.errorCode).toBe('CHANNEL_ARCHIVED');

      // GET → 409 (조회도 일관되게 막는다).
      const get = await request(env.baseUrl)
        .get(`/messages/${msgId}/reactions`)
        .set(bearer(stack.member.accessToken));
      expect(get.status).toBe(409);
      expect(get.body.errorCode).toBe('CHANNEL_ARCHIVED');
    } finally {
      // 후속 테스트가 동일 채널을 쓰므로 보관 상태를 되돌린다.
      await env.prisma.channel.update({
        where: { id: stack.channelId },
        data: { archivedAt: null },
      });
    }
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

  // ── S40 (FR-RE07): ADD_REACTIONS(카탈로그 0x20) override → ADR-4 fold ─────────
  // API enum 은 수정하지 않는다(D12). override 는 카탈로그 비트로 저장되며, 컨트롤러
  // canAddReaction 은 PermissionMatrix.fold 와 동일한 우선순위
  // (base→roleAllow→roleDeny→userAllow→userDeny, 나중=우선)로 fold 한다. 반응 base 는
  // 기본 허용이라, 명시 override 가 없으면 통과한다.
  const ADD_REACTIONS_BIT = 0x20; // 카탈로그 PERMISSIONS.ADD_REACTIONS

  // (a) USER denyMask ADD_REACTIONS → 403. 제거(toggle off)·조회는 무관.
  it('FR-RE07(a): USER DENY override 유저는 반응 추가 시 403, override 없는 유저는 정상', async () => {
    const msgId = await postMessage(stack.admin.accessToken);

    // member 본인에게 ADD_REACTIONS DENY override 를 건다.
    await env.prisma.channelPermissionOverride.create({
      data: {
        channelId: stack.channelId,
        principalType: 'USER',
        principalId: stack.member.userId,
        allowMask: 0,
        denyMask: ADD_REACTIONS_BIT,
      },
    });
    try {
      // member: 추가(INSERT) → 403 FORBIDDEN.
      const denied = await request(env.baseUrl)
        .post(`/messages/${msgId}/reactions`)
        .set(bearer(stack.member.accessToken))
        .send({ emoji: '👍' });
      expect(denied.status).toBe(403);
      expect(denied.body.errorCode).toBe('FORBIDDEN');

      // (d) admin(override 없음): 기본 허용 → 정상 추가.
      const ok = await request(env.baseUrl)
        .post(`/messages/${msgId}/reactions`)
        .set(bearer(stack.admin.accessToken))
        .send({ emoji: '👍' });
      expect(ok.status).toBe(200);
      expect(ok.body.byMe).toBe(true);

      // 제거(DELETE) 경로는 ADD_REACTIONS 게이트를 타지 않는다 — member 가 자기
      // (없는) 반응을 DELETE 해도 403 이 아니라 no-op 204 다. add(INSERT)만 막힌다.
      const memberSelfDelete = await request(env.baseUrl)
        .delete(`/messages/${msgId}/reactions/${encodeURIComponent('👍')}`)
        .set(bearer(stack.member.accessToken));
      expect(memberSelfDelete.status).toBe(204);
    } finally {
      await env.prisma.channelPermissionOverride.deleteMany({
        where: { channelId: stack.channelId, principalId: stack.member.userId },
      });
    }
  });

  // (b) ROLE(멤버 role) denyMask → 그 role 의 모든 유저가 403.
  it('FR-RE07(b): ROLE(MEMBER) DENY override 면 해당 role 유저는 반응 추가 시 403', async () => {
    const msgId = await postMessage(stack.admin.accessToken);

    // MEMBER role 자체에 ADD_REACTIONS DENY 를 건다(member 는 MEMBER role).
    await env.prisma.channelPermissionOverride.create({
      data: {
        channelId: stack.channelId,
        principalType: 'ROLE',
        principalId: 'MEMBER',
        allowMask: 0,
        denyMask: ADD_REACTIONS_BIT,
      },
    });
    try {
      const denied = await request(env.baseUrl)
        .post(`/messages/${msgId}/reactions`)
        .set(bearer(stack.member.accessToken))
        .send({ emoji: '👍' });
      expect(denied.status).toBe(403);
      expect(denied.body.errorCode).toBe('FORBIDDEN');

      // ADMIN role 유저는 영향 없음(다른 ROLE) → 정상 추가.
      const ok = await request(env.baseUrl)
        .post(`/messages/${msgId}/reactions`)
        .set(bearer(stack.admin.accessToken))
        .send({ emoji: '👍' });
      expect(ok.status).toBe(200);
    } finally {
      await env.prisma.channelPermissionOverride.deleteMany({
        where: { channelId: stack.channelId, principalType: 'ROLE', principalId: 'MEMBER' },
      });
    }
  });

  // (c) ROLE deny + 같은 유저 USER allow → 허용(200). userAllow 가 roleDeny 를 이김(ADR-4).
  // 종전 단순 OR 폴드는 이 케이스를 잘못 403 했다 — fold 정정의 핵심 회귀 가드.
  it('FR-RE07(c): ROLE DENY + 같은 유저 USER ALLOW 면 userAllow 가 이겨 허용(200)', async () => {
    const msgId = await postMessage(stack.admin.accessToken);

    await env.prisma.channelPermissionOverride.create({
      data: {
        channelId: stack.channelId,
        principalType: 'ROLE',
        principalId: 'MEMBER',
        allowMask: 0,
        denyMask: ADD_REACTIONS_BIT,
      },
    });
    await env.prisma.channelPermissionOverride.create({
      data: {
        channelId: stack.channelId,
        principalType: 'USER',
        principalId: stack.member.userId,
        allowMask: ADD_REACTIONS_BIT,
        denyMask: 0,
      },
    });
    try {
      const ok = await request(env.baseUrl)
        .post(`/messages/${msgId}/reactions`)
        .set(bearer(stack.member.accessToken))
        .send({ emoji: '👍' });
      expect(ok.status).toBe(200);
      expect(ok.body.byMe).toBe(true);
    } finally {
      await env.prisma.channelPermissionOverride.deleteMany({
        where: {
          channelId: stack.channelId,
          OR: [
            { principalType: 'ROLE', principalId: 'MEMBER' },
            { principalType: 'USER', principalId: stack.member.userId },
          ],
        },
      });
    }
  });

  // (d) override 전무 → 기본 허용(200). base=true 출발 확인.
  it('FR-RE07(d): override 가 전혀 없으면 반응 추가는 기본 허용(200)', async () => {
    const msgId = await postMessage(stack.admin.accessToken);
    const ok = await request(env.baseUrl)
      .post(`/messages/${msgId}/reactions`)
      .set(bearer(stack.member.accessToken))
      .send({ emoji: '👍' });
    expect(ok.status).toBe(200);
    expect(ok.body.byMe).toBe(true);
  });

  // ── S40 (FR-RE08): OWNER/ADMIN 의 타인 반응 제거 ────────────────────────────
  it('FR-RE08: MEMBER 는 타인 반응 제거 403, OWNER/ADMIN 은 성공, 자기 제거는 허용', async () => {
    const msgId = await postMessage(stack.owner.accessToken);
    // member 가 👍 반응을 단다.
    await request(env.baseUrl)
      .post(`/messages/${msgId}/reactions`)
      .set(bearer(stack.member.accessToken))
      .send({ emoji: '👍' })
      .expect(200);

    // 다른 MEMBER(여기선 nonMember 는 채널 밖이므로, admin 을 강등하지 않고 member 가
    // owner 의 반응을 지우려 시도). owner 가 👎 를 달아둔다.
    await request(env.baseUrl)
      .post(`/messages/${msgId}/reactions`)
      .set(bearer(stack.owner.accessToken))
      .send({ emoji: '👎' })
      .expect(200);

    // MEMBER 가 owner(타인)의 👎 반응 제거 시도 → 403.
    const memberDeniesOther = await request(env.baseUrl)
      .delete(
        `/messages/${msgId}/reactions/${encodeURIComponent('👎')}/users/${stack.owner.userId}`,
      )
      .set(bearer(stack.member.accessToken));
    expect(memberDeniesOther.status).toBe(403);

    // ADMIN 이 member(타인)의 👍 반응 제거 → 204 성공.
    const adminRemovesOther = await request(env.baseUrl)
      .delete(
        `/messages/${msgId}/reactions/${encodeURIComponent('👍')}/users/${stack.member.userId}`,
      )
      .set(bearer(stack.admin.accessToken));
    expect(adminRemovesOther.status).toBe(204);

    // OWNER 가 member 의 (이미 없는) 👍 재제거 → no-op 204.
    const ownerNoop = await request(env.baseUrl)
      .delete(
        `/messages/${msgId}/reactions/${encodeURIComponent('👍')}/users/${stack.member.userId}`,
      )
      .set(bearer(stack.owner.accessToken));
    expect(ownerNoop.status).toBe(204);

    // 자기 반응 제거(actor === target)는 MEMBER 도 허용 — owner 가 자기 👎 제거.
    const ownerSelf = await request(env.baseUrl)
      .delete(
        `/messages/${msgId}/reactions/${encodeURIComponent('👎')}/users/${stack.owner.userId}`,
      )
      .set(bearer(stack.owner.accessToken));
    expect(ownerSelf.status).toBe(204);

    // 최종: 모든 반응이 제거됐다.
    const rows = await env.prisma.messageReaction.findMany({ where: { messageId: msgId } });
    expect(rows).toHaveLength(0);
  });

  // ── S40 (FR-RE05): reactor 전체 목록 cursor 페이지네이션 ───────────────────
  it('FR-RE05: GET .../:emoji/users 가 (createdAt,id) cursor 로 reactor 전원을 페이지네이션', async () => {
    const msgId = await postMessage(stack.owner.accessToken);
    // 3명이 동일 이모지에 반응(member, admin, owner).
    for (const a of [stack.member, stack.admin, stack.owner]) {
      await request(env.baseUrl)
        .post(`/messages/${msgId}/reactions`)
        .set(bearer(a.accessToken))
        .send({ emoji: '🔥' })
        .expect(200);
    }

    // limit=2 → 첫 페이지 2명 + nextCursor.
    const p1 = await request(env.baseUrl)
      .get(`/messages/${msgId}/reactions/${encodeURIComponent('🔥')}/users?limit=2`)
      .set(bearer(stack.member.accessToken));
    expect(p1.status).toBe(200);
    expect(p1.body.users).toHaveLength(2);
    expect(p1.body.nextCursor).toBeTruthy();
    expect(p1.body.users.every((u: { username: string | null }) => 'username' in u)).toBe(true);

    // 둘째 페이지 → 나머지 1명 + nextCursor null.
    const p2 = await request(env.baseUrl)
      .get(
        `/messages/${msgId}/reactions/${encodeURIComponent('🔥')}/users?limit=2&cursor=${encodeURIComponent(
          p1.body.nextCursor,
        )}`,
      )
      .set(bearer(stack.member.accessToken));
    expect(p2.status).toBe(200);
    expect(p2.body.users).toHaveLength(1);
    expect(p2.body.nextCursor).toBeNull();

    // 전체 합집합이 3명 전원이고 중복이 없다.
    const allIds = [...p1.body.users, ...p2.body.users].map((u: { id: string }) => u.id);
    expect(new Set(allIds).size).toBe(3);
    expect(new Set(allIds)).toEqual(
      new Set([stack.member.userId, stack.admin.userId, stack.owner.userId]),
    );
  });

  // ── S40 (FR-RE09): 전체 반응 일괄 삭제 + reaction.cleared 이벤트 ────────────
  it('FR-RE09: 비OWNER/ADMIN 은 일괄 삭제 403, OWNER 는 204 + message.reaction.cleared', async () => {
    const msgId = await postMessage(stack.owner.accessToken);
    for (const [a, e] of [
      [stack.member, '👍'],
      [stack.admin, '🎉'],
      [stack.owner, '🔥'],
    ] as const) {
      await request(env.baseUrl)
        .post(`/messages/${msgId}/reactions`)
        .set(bearer(a.accessToken))
        .send({ emoji: e })
        .expect(200);
    }

    // MEMBER 일괄 삭제 → 403.
    const memberClear = await request(env.baseUrl)
      .delete(`/messages/${msgId}/reactions`)
      .set(bearer(stack.member.accessToken));
    expect(memberClear.status).toBe(403);

    // 아직 3종이 남아있다.
    const before = await env.prisma.messageReaction.findMany({ where: { messageId: msgId } });
    expect(before).toHaveLength(3);

    // OWNER 일괄 삭제 → 204.
    const ownerClear = await request(env.baseUrl)
      .delete(`/messages/${msgId}/reactions`)
      .set(bearer(stack.owner.accessToken));
    expect(ownerClear.status).toBe(204);

    // 모든 반응이 사라졌다.
    const after = await env.prisma.messageReaction.findMany({ where: { messageId: msgId } });
    expect(after).toHaveLength(0);

    // message.reaction.cleared outbox 이벤트 1건이 발행됐다.
    const cleared = await env.prisma.outboxEvent.findMany({
      where: { aggregateId: msgId, eventType: 'message.reaction.cleared' },
    });
    expect(cleared).toHaveLength(1);
    expect((cleared[0].payload as { channelId: string }).channelId).toBe(stack.channelId);
    expect((cleared[0].payload as { messageId: string }).messageId).toBe(msgId);

    // 반응이 없는 메시지에 재호출 → no-op 204, 추가 이벤트 없음.
    const ownerClearAgain = await request(env.baseUrl)
      .delete(`/messages/${msgId}/reactions`)
      .set(bearer(stack.owner.accessToken));
    expect(ownerClearAgain.status).toBe(204);
    const clearedAfter = await env.prisma.outboxEvent.findMany({
      where: { aggregateId: msgId, eventType: 'message.reaction.cleared' },
    });
    expect(clearedAfter).toHaveLength(1);
  });
});
