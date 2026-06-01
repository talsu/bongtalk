import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io-client';
import {
  collectEvents,
  connectReady,
  seedRtStack,
  setupRtIntEnv,
  waitForEvent,
  type RtIntEnv,
} from './helpers';

let env: RtIntEnv;
let stack: Awaited<ReturnType<typeof seedRtStack>>;

// 한 테스트가 timeout 으로 중도 throw 해도 소켓이 leak 되지 않도록 모든 연결을
// 등록해 afterEach 에서 강제 정리합니다. leak 된 connected 소켓이 다음 테스트의
// Redis 상태/브로드캐스트를 오염시키던 cross-test contamination 을 막습니다.
const liveSockets: Socket[] = [];
async function connect(token: string): Promise<Socket> {
  const s = await connectReady(env.wsUrl, token);
  liveSockets.push(s);
  return s;
}

beforeAll(async () => {
  env = await setupRtIntEnv();
  stack = await seedRtStack(env.baseUrl);
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

/**
 * 앱 Redis 클라이언트는 `keyPrefix: 'qufox:'` 로 설정돼 있습니다. ioredis 는
 * KEYS 의 패턴 인자에는 prefix 를 적용하지 않으므로 `keys('typing:*')` 는 실제
 * 키(`qufox:typing:*`)를 찾지 못합니다. 따라서 prefixed 패턴으로 조회한 뒤,
 * del 이 다시 prefix 를 붙이지 않도록 논리 키 이름(prefix 제거분)으로 삭제합니다.
 * (이 prefix 불일치가 종전 flush 를 no-op 으로 만들어, owner 의 3초 throttle
 * 키가 테스트 간 잔류 → 다음 ping 이 침묵당하던 cross-test 오염의 원인이었습니다.)
 */
async function flushTypingKeys(): Promise<void> {
  const prefixed = await env.redis.keys('qufox:typing:*');
  if (prefixed.length === 0) return;
  const logical = prefixed.map((k) => k.replace(/^qufox:/, ''));
  await env.redis.del(...logical);
}

beforeEach(async () => {
  await flushTypingKeys();
});

afterEach(async () => {
  // 모든 테스트 소켓을 정리하고, 비동기 disconnect 핸들러(dropForUser →
  // onTypersChanged 의 Redis write)가 끝날 때까지 settle 한 뒤 typing 키를
  // 다시 비웁니다. 다음 beforeEach 의 flush 와 이중으로 contamination 을 막습니다.
  while (liveSockets.length > 0) {
    const s = liveSockets.pop();
    s?.disconnect();
  }
  await new Promise((r) => setTimeout(r, 300));
  await flushTypingKeys();
});

/**
 * S32 (FR-RT-08/09/17): typing indicator gateway contract.
 *
 * - Client emits `typing:start { channelId }` (dot `typing.ping` still
 *   accepted for rollout compat via a socket-level forward); server
 *   broadcasts `typing:update { channelId, typingUserIds }` (colon) to every
 *   socket in the channel room.
 * - Per-user-per-channel throttle: consecutive starts inside
 *   TYPING_THROTTLE_SEC (default 3 s) drop silently.
 * - FR-RT-17: Redis ZSET `typing:channel:<channelId>` (member=userId,
 *   score=expiry epoch ms) holds the typing members with PER-USER expiry —
 *   one user going quiet doesn't keep another alive.
 * - Disconnect hook proactively drops the user from every channel.
 */
describe('typing gateway (S32 · FR-RT-08/17)', () => {
  it('A starts → B receives typing:update with A in the set', async () => {
    const a = await connect(stack.owner.accessToken);
    const b = await connect(stack.member.accessToken);

    const received = waitForEvent<{ channelId: string; typingUserIds: string[] }>(
      b,
      'typing:update',
      3000,
    );
    a.emit('typing:start', { channelId: stack.channelId });

    const ev = await received;
    expect(ev.channelId).toBe(stack.channelId);
    expect(ev.typingUserIds).toContain(stack.owner.userId);
  });

  it('accepts the dot-form `typing.ping` alias during rollout', async () => {
    const a = await connect(stack.owner.accessToken);
    const b = await connect(stack.member.accessToken);

    const received = waitForEvent<{ channelId: string; typingUserIds: string[] }>(
      b,
      'typing:update',
      3000,
    );
    a.emit('typing.ping', { channelId: stack.channelId });
    const ev = await received;
    expect(ev.typingUserIds).toContain(stack.owner.userId);
  });

  it('throttles consecutive starts from the same user within the window', async () => {
    const a = await connect(stack.owner.accessToken);
    const b = await connect(stack.member.accessToken);

    const count = { n: 0 };
    b.on('typing:update', () => {
      count.n += 1;
    });

    a.emit('typing:start', { channelId: stack.channelId });
    await new Promise((r) => setTimeout(r, 200));
    a.emit('typing:start', { channelId: stack.channelId });
    a.emit('typing:start', { channelId: stack.channelId });
    await new Promise((r) => setTimeout(r, 400));

    expect(count.n).toBe(1);
  });

  it('FR-RT-17: ZSET holds the userId with a finite key TTL after a start', async () => {
    const a = await connect(stack.owner.accessToken);
    const b = await connect(stack.member.accessToken);
    // 브로드캐스트를 기다려 ping() 의 ZADD 가 확정된 뒤 외부에서 읽습니다(타이밍
    // 경쟁 제거 — 단순 sleep 대신 update 수신을 동기점으로 사용).
    const received = waitForEvent<{ typingUserIds: string[] }>(b, 'typing:update', 3000);
    a.emit('typing:start', { channelId: stack.channelId });
    await received;

    const key = `typing:channel:${stack.channelId}`;
    const members = await env.redis.zrange(key, 0, -1);
    expect(members).toContain(stack.owner.userId);
    // 빈 채널 GC 안전망: 키 TTL = TYPING_TTL + 5 = 15s 이하, 0 초과.
    const ttl = await env.redis.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(15);
  });

  it('disconnect clears the user from typing ZSET and fan-outs update', async () => {
    const a = await connect(stack.owner.accessToken);
    const b = await connect(stack.member.accessToken);

    a.emit('typing:start', { channelId: stack.channelId });
    await waitForEvent(b, 'typing:update', 2000);

    const afterDisconnect = waitForEvent<{ typingUserIds: string[] }>(b, 'typing:update', 3000);
    a.disconnect();

    const ev = await afterDisconnect;
    expect(ev.typingUserIds).not.toContain(stack.owner.userId);
  });

  it('ignores starts for channels the caller is not a member of', async () => {
    const nm = await connect(stack.nonMember.accessToken);
    const b = await connect(stack.member.accessToken);

    let received = false;
    b.on('typing:update', () => {
      received = true;
    });

    nm.emit('typing:start', { channelId: stack.channelId });
    await new Promise((r) => setTimeout(r, 500));

    expect(received).toBe(false);
    const members = await env.redis.zrange(`typing:channel:${stack.channelId}`, 0, -1);
    expect(members).not.toContain(stack.nonMember.userId);
  });
});

/**
 * S32 (FR-RT-17): per-user independent expiry. A pre-seeded already-expired
 * member must not survive another user's live start (the old SET TTL-reset
 * bug). We seed a phantom with a past expiry score directly into the ZSET,
 * then have B start — B's path lazily GCs the phantom (ZREMRANGEBYSCORE
 * 0..now) and the broadcast names B only.
 */
describe('S32 typing — ZSET per-user expiry (FR-RT-17)', () => {
  it('an expired member is dropped, a live member survives', async () => {
    const b = await connect(stack.member.accessToken);
    const observer = await connect(stack.owner.accessToken);

    const key = `typing:channel:${stack.channelId}`;
    // Seed a phantom typer whose expiry is already in the past (epoch 1).
    await env.redis.zadd(key, 1, 'phantom-stale-id');

    const received = waitForEvent<{ typingUserIds: string[] }>(observer, 'typing:update', 3000);
    b.emit('typing:start', { channelId: stack.channelId });
    const ev = await received;

    expect(ev.typingUserIds).toContain(stack.member.userId);
    expect(ev.typingUserIds).not.toContain('phantom-stale-id');
    const members = await env.redis.zrange(key, 0, -1);
    expect(members).not.toContain('phantom-stale-id');
  });
});

/**
 * S26 (FR-DM-14): DM channels reuse the SAME typing path — no `dm:typing_*`
 * prefix. A DIRECT channel is admitted via its USER ALLOW override, so
 * typing:start passes the membership check and broadcasts typing:update.
 */
describe('S26 typing — DM channel uses the unified path (FR-DM-14)', () => {
  let dmChannelId: string;

  beforeEach(async () => {
    const dm = await env.prisma.channel.create({
      data: {
        workspaceId: stack.workspaceId,
        name: `dm-typing-${Date.now().toString(36)}`,
        type: 'DIRECT',
        position: 9000,
        isPrivate: true,
      },
    });
    dmChannelId = dm.id;
    for (const uid of [stack.owner.userId, stack.member.userId]) {
      await env.prisma.channelPermissionOverride.create({
        data: {
          channelId: dm.id,
          principalType: 'USER',
          principalId: uid,
          allowMask: 1,
          denyMask: 0,
        },
      });
    }
  });

  it('A starts in a DM channel → B receives typing:update (no dm: prefix)', async () => {
    const a = await connect(stack.owner.accessToken);
    const b = await connect(stack.member.accessToken);

    const received = waitForEvent<{ channelId: string; typingUserIds: string[] }>(
      b,
      'typing:update',
      3000,
    );
    a.emit('typing:start', { channelId: dmChannelId });

    const ev = await received;
    expect(ev.channelId).toBe(dmChannelId);
    expect(ev.typingUserIds).toContain(stack.owner.userId);

    const members = await env.redis.zrange(`typing:channel:${dmChannelId}`, 0, -1);
    expect(members).toContain(stack.owner.userId);
  });
});

/**
 * S32 (FR-RT-08): when ≥ TYPING_MAX_VISIBLE (3) users type, the server stops
 * shipping single `typing:update` events and emits `typing:batch` full
 * snapshots on the TYPING_BATCH_INTERVAL cadence, capped to 3 ids on the wire.
 *
 * S32 fix-forward(contract CRITICAL · 4팀 합의): typing:batch 의 와이어 필드명을
 * typing:update 와 동일하게 `typingUserIds` 로 통일했다. 종전 int spec 은 batch 만
 * `userIds` 를 참조했는데, 통일 후 와이어가 `typingUserIds` 를 싣는다.
 */
describe('S32 typing — batch threshold (FR-RT-08)', () => {
  it('3+ typers trigger typing:batch full-snapshot (capped at 3, typingUserIds)', async () => {
    const observer = await connect(stack.owner.accessToken);
    const t1 = await connect(stack.member.accessToken);
    const t2 = await connect(stack.admin.accessToken);

    const batches = collectEvents<{ channelId: string; typingUserIds: string[] }>(
      observer,
      'typing:batch',
      1500,
    );

    t1.emit('typing:start', { channelId: stack.channelId });
    await new Promise((r) => setTimeout(r, 50));
    t2.emit('typing:start', { channelId: stack.channelId });
    await new Promise((r) => setTimeout(r, 50));
    observer.emit('typing:start', { channelId: stack.channelId });

    const events = await batches;
    expect(events.length).toBeGreaterThan(0);
    for (const ev of events) {
      expect(ev.channelId).toBe(stack.channelId);
      expect(ev.typingUserIds.length).toBeLessThanOrEqual(3);
    }
  });
});
