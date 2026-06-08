import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AutoModSpamService } from './automod-spam.service';

/**
 * FR-RM10b (069) 단위 테스트 — MENTION_SPAM / REPEAT_SPAM Redis sliding window.
 *
 * 외부(Redis)는 정직한 in-memory ZSET 스텁(vi.fn 만 · 외부 모킹 라이브러리 금지)으로
 * 흉내낸다(upload-rate-limit.spec 패턴). 시간(at) 주입으로 윈도를 결정적으로 제어한다.
 */

const WS = '11111111-1111-1111-1111-111111111111';
const RULE = '22222222-2222-2222-2222-222222222222';
const USER = '33333333-3333-3333-3333-333333333333';

function makeRedisStub() {
  const store = new Map<string, Array<{ score: number; member: string }>>();
  function pipeline() {
    const ops: Array<() => unknown> = [];
    const api = {
      zremrangebyscore(key: string, min: number, max: number) {
        ops.push(() => {
          const arr = store.get(key) ?? [];
          store.set(
            key,
            arr.filter((e) => !(e.score >= min && e.score <= max)),
          );
          return 0;
        });
        return api;
      },
      zadd(key: string, score: number, member: string) {
        ops.push(() => {
          // ★실 Redis ZSET 시맨틱: member 가 같으면 score 만 갱신(중복 추가 아님). MED-3 회귀가
          // member 충돌을 감지하려면 stub 도 member 기준 dedup 해야 한다(종전 단순 push 는 충돌을
          // 못 잡아 의미가 없었다).
          const arr = store.get(key) ?? [];
          const existing = arr.find((e) => e.member === member);
          if (existing) existing.score = score;
          else arr.push({ score, member });
          store.set(key, arr);
          return 1;
        });
        return api;
      },
      zcard(key: string) {
        ops.push(() => (store.get(key) ?? []).length);
        return api;
      },
      expire() {
        ops.push(() => 1);
        return api;
      },
      async exec() {
        return ops.map((op) => [null, op()] as [null, unknown]);
      },
    };
    return api;
  }
  return {
    multi: () => pipeline(),
    keys: async (pattern: string) => {
      const prefix = pattern.replace(/\*$/, '');
      return [...store.keys()].filter((k) => k.startsWith(prefix));
    },
    del: async (...keys: string[]) => {
      for (const k of keys) store.delete(k);
      return keys.length;
    },
    __store: store,
  };
}

/** 항상 throw 하는 Redis 스텁(best-effort 흡수 검증용). */
function makeThrowingRedis() {
  return {
    multi: () => {
      throw new Error('redis down');
    },
    keys: async () => {
      throw new Error('redis down');
    },
    del: async () => {
      throw new Error('redis down');
    },
  };
}

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('AutoModSpamService.contentHash', () => {
  it('normalizes case/whitespace so equivalent messages hash identically', () => {
    const a = AutoModSpamService.contentHash('  Hello   World  ');
    const b = AutoModSpamService.contentHash('hello world');
    expect(a).toBe(b);
    expect(a).toHaveLength(16);
  });

  it('different content yields different hashes', () => {
    expect(AutoModSpamService.contentHash('spam one')).not.toBe(
      AutoModSpamService.contentHash('spam two'),
    );
  });

  it('empty / whitespace-only content yields empty hash (skip)', () => {
    expect(AutoModSpamService.contentHash('   ')).toBe('');
    expect(AutoModSpamService.contentHash('')).toBe('');
  });
});

describe('AutoModSpamService.recordAndCountMentions (MENTION_SPAM)', () => {
  it('accumulates mention counts across messages in the window', async () => {
    const svc = new AutoModSpamService(makeRedisStub() as never);
    const at = new Date('2025-01-01T00:00:00Z');
    // 첫 메시지 3 멘션 → 누적 3.
    const c1 = await svc.recordAndCountMentions({
      workspaceId: WS,
      ruleId: RULE,
      userId: USER,
      mentionCount: 3,
      windowSeconds: 60,
      at,
    });
    expect(c1).toBe(3);
    // 두 번째 메시지 2 멘션(같은 윈도) → 누적 5.
    const c2 = await svc.recordAndCountMentions({
      workspaceId: WS,
      ruleId: RULE,
      userId: USER,
      mentionCount: 2,
      windowSeconds: 60,
      at,
    });
    expect(c2).toBe(5);
  });

  it('slides out mentions older than the window', async () => {
    const svc = new AutoModSpamService(makeRedisStub() as never);
    const t0 = new Date('2025-01-01T00:00:00Z');
    await svc.recordAndCountMentions({
      workspaceId: WS,
      ruleId: RULE,
      userId: USER,
      mentionCount: 4,
      windowSeconds: 60,
      at: t0,
    });
    // 61초 뒤 — 이전 4개는 윈도 밖으로 빠지고 이번 1개만 남는다.
    const later = new Date(t0.getTime() + 61_000);
    const c = await svc.recordAndCountMentions({
      workspaceId: WS,
      ruleId: RULE,
      userId: USER,
      mentionCount: 1,
      windowSeconds: 60,
      at: later,
    });
    expect(c).toBe(1);
  });

  it('★MED-3: counts two records at the SAME ms without member collision', async () => {
    // member 가 `${nowMs}-${randomUUID()}` 라 같은 ms·같은 seq 라도 충돌하지 않는다(다중노드 안전).
    // 종전 `${nowMs}-${seq}` 라도 단일 프로세스에선 seq 가 달랐지만, 본 테스트는 member 가 ms 만으로
    // 결정되지 않음(고유 salt 포함)을 확인해 다중노드 언더카운트 회귀를 막는다.
    const svc = new AutoModSpamService(makeRedisStub() as never);
    const at = new Date('2025-01-01T00:00:00Z'); // 두 호출 모두 동일 ms.
    const c1 = await svc.recordAndCountMentions({
      workspaceId: WS,
      ruleId: RULE,
      userId: USER,
      mentionCount: 1,
      windowSeconds: 60,
      at,
    });
    const c2 = await svc.recordAndCountMentions({
      workspaceId: WS,
      ruleId: RULE,
      userId: USER,
      mentionCount: 1,
      windowSeconds: 60,
      at,
    });
    expect(c1).toBe(1);
    expect(c2).toBe(2); // 충돌 없이 누적(언더카운트 아님).
  });

  it('★MED-3: members are unique even with multiple mentions at the same ms', async () => {
    // 한 메시지가 mentionCount=3 이면 같은 ms 에 3 member 를 ZADD — 전부 고유해야 ZCARD=3.
    const stub = makeRedisStub();
    const svc = new AutoModSpamService(stub as never);
    const at = new Date('2025-01-01T00:00:00Z');
    const c = await svc.recordAndCountMentions({
      workspaceId: WS,
      ruleId: RULE,
      userId: USER,
      mentionCount: 3,
      windowSeconds: 60,
      at,
    });
    expect(c).toBe(3);
    // store 의 member 들이 전부 distinct(같은 ms 라도 randomUUID salt 로 고유).
    const key = `automod:mspam:${WS}:${RULE}:${USER}`;
    const members = (stub.__store.get(key) ?? []).map((e) => e.member);
    expect(new Set(members).size).toBe(3);
  });

  it('★MED-3: REPEAT_SPAM members are unique at the same ms', async () => {
    const stub = makeRedisStub();
    const svc = new AutoModSpamService(stub as never);
    const at = new Date('2025-01-01T00:00:00Z');
    await svc.recordAndCountRepeats({
      workspaceId: WS,
      ruleId: RULE,
      userId: USER,
      contentPlain: 'same body',
      windowSeconds: 60,
      at,
    });
    const c = await svc.recordAndCountRepeats({
      workspaceId: WS,
      ruleId: RULE,
      userId: USER,
      contentPlain: 'same body',
      windowSeconds: 60,
      at,
    });
    expect(c).toBe(2); // 동일 본문·동일 ms 2회 → 2(충돌 언더카운트 없음).
  });

  it('returns 0 when mentionCount is 0 (no-op)', async () => {
    const svc = new AutoModSpamService(makeRedisStub() as never);
    const c = await svc.recordAndCountMentions({
      workspaceId: WS,
      ruleId: RULE,
      userId: USER,
      mentionCount: 0,
      windowSeconds: 60,
    });
    expect(c).toBe(0);
  });

  it('absorbs Redis errors (best-effort → 0)', async () => {
    const svc = new AutoModSpamService(makeThrowingRedis() as never);
    const c = await svc.recordAndCountMentions({
      workspaceId: WS,
      ruleId: RULE,
      userId: USER,
      mentionCount: 5,
      windowSeconds: 60,
    });
    expect(c).toBe(0);
  });
});

describe('AutoModSpamService.recordAndCountRepeats (REPEAT_SPAM)', () => {
  it('counts identical (normalized) content repeats within the window', async () => {
    const svc = new AutoModSpamService(makeRedisStub() as never);
    const at = new Date('2025-01-01T00:00:00Z');
    const send = (content: string) =>
      svc.recordAndCountRepeats({
        workspaceId: WS,
        ruleId: RULE,
        userId: USER,
        contentPlain: content,
        windowSeconds: 60,
        at,
      });
    expect(await send('buy now!!!')).toBe(1);
    // 대소문자/공백만 다른 동일 본문 → 반복 카운트 누적.
    expect(await send('BUY   NOW!!!')).toBe(2);
    expect(await send('buy now!!!')).toBe(3);
    // 다른 본문은 별도 해시 → 1.
    expect(await send('completely different')).toBe(1);
  });

  it('slides out repeats older than the window', async () => {
    const svc = new AutoModSpamService(makeRedisStub() as never);
    const t0 = new Date('2025-01-01T00:00:00Z');
    await svc.recordAndCountRepeats({
      workspaceId: WS,
      ruleId: RULE,
      userId: USER,
      contentPlain: 'repeat me',
      windowSeconds: 30,
      at: t0,
    });
    const later = new Date(t0.getTime() + 31_000);
    const c = await svc.recordAndCountRepeats({
      workspaceId: WS,
      ruleId: RULE,
      userId: USER,
      contentPlain: 'repeat me',
      windowSeconds: 30,
      at: later,
    });
    expect(c).toBe(1);
  });

  it('returns 0 for empty content (skip)', async () => {
    const svc = new AutoModSpamService(makeRedisStub() as never);
    const c = await svc.recordAndCountRepeats({
      workspaceId: WS,
      ruleId: RULE,
      userId: USER,
      contentPlain: '   ',
      windowSeconds: 60,
    });
    expect(c).toBe(0);
  });

  it('absorbs Redis errors (best-effort → 0)', async () => {
    const svc = new AutoModSpamService(makeThrowingRedis() as never);
    const c = await svc.recordAndCountRepeats({
      workspaceId: WS,
      ruleId: RULE,
      userId: USER,
      contentPlain: 'x',
      windowSeconds: 60,
    });
    expect(c).toBe(0);
  });
});
