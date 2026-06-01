import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { TypingService } from '../../../src/realtime/typing/typing.service';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

const CH = 'channel-1';
const A = 'user-a';
const B = 'user-b';
const C = 'user-c';
const D = 'user-d';

/**
 * S32 (FR-RT-17): TypingService 가 사용하는 Redis 명령만 구현한 in-memory 더블.
 * ZSET(score 정렬) + 단순 string SET NX/EX + multi 파이프라인을 흉내냅니다.
 * 외부 모킹 라이브러리 없이 vi.fn() 컨벤션을 따르되, 자료구조 시뮬레이션은
 * 순수 클래스로 둡니다(호출 검증보다 동작 검증이 목적).
 */
class FakeRedis {
  private zsets = new Map<string, Map<string, number>>();
  /** string 키 → 만료 epoch ms (EX 적용). 만료 시 자연 소멸. */
  private strings = new Map<string, number>();
  private keyTtl = new Map<string, number>();
  /** S32 (perf R-1): multi() 호출 수 = round-trip 수(테스트 측정용). */
  multiCount = 0;

  /** 주입 clock 으로 EX 만료를 결정적으로 처리(string 스로틀 키용). */
  constructor(private readonly nowFn: () => number) {}

  private z(key: string): Map<string, number> {
    let m = this.zsets.get(key);
    if (!m) {
      m = new Map();
      this.zsets.set(key, m);
    }
    return m;
  }

  private stringAlive(key: string): boolean {
    const expireAt = this.strings.get(key);
    if (expireAt === undefined) return false;
    if (expireAt <= this.nowFn()) {
      this.strings.delete(key);
      return false;
    }
    return true;
  }

  async set(key: string, _val: string, _ex: 'EX', sec: number, nx: 'NX'): Promise<'OK' | null> {
    if (nx === 'NX' && this.stringAlive(key)) return null;
    this.strings.set(key, this.nowFn() + sec * 1000);
    return 'OK';
  }

  /** del 은 string + zset 모두에서 제거. multi 경로에서도 호출됨. */
  private delKey(key: string): number {
    let n = 0;
    if (this.strings.delete(key)) n = 1;
    if (this.zsets.delete(key)) n = 1;
    this.keyTtl.delete(key);
    return n;
  }

  private zaddKey(key: string, score: number, member: string): number {
    const m = this.z(key);
    const existed = m.has(member);
    m.set(member, score);
    return existed ? 0 : 1;
  }

  private zremKey(key: string, member: string): number {
    const m = this.zsets.get(key);
    if (!m) return 0;
    return m.delete(member) ? 1 : 0;
  }

  private zremrangebyscoreKey(key: string, min: number, max: number): number {
    const m = this.zsets.get(key);
    if (!m) return 0;
    let removed = 0;
    for (const [member, score] of [...m.entries()]) {
      if (score >= min && score <= max) {
        m.delete(member);
        removed++;
      }
    }
    return removed;
  }

  /** `(${now}` 형태의 exclusive min + '+inf' max 만 지원하면 충분. */
  private zrangebyscoreKey(key: string, minRaw: string, _max: string): string[] {
    const m = this.zsets.get(key);
    if (!m) return [];
    const exclusive = minRaw.startsWith('(');
    const min = Number(exclusive ? minRaw.slice(1) : minRaw);
    const out: Array<[string, number]> = [];
    for (const [member, score] of m.entries()) {
      if (exclusive ? score > min : score >= min) out.push([member, score]);
    }
    // ZSET 은 score asc 정렬 반환.
    out.sort((x, y) => x[1] - y[1]);
    return out.map(([member]) => member);
  }

  async smembers(): Promise<string[]> {
    throw new Error('smembers must not be used — service moved to ZSET (FR-RT-17)');
  }

  async ttl(key: string): Promise<number> {
    return this.keyTtl.get(key) ?? -1;
  }

  /** 테스트 헬퍼: ZSET 멤버 수(만료 무관 raw). */
  rawZcard(key: string): number {
    return this.zsets.get(key)?.size ?? 0;
  }

  /** ioredis multi 체이닝 더블. exec() 가 [err, result][] 를 반환. */
  multi(): FakeMulti {
    this.multiCount++;
    return new FakeMulti(this);
  }

  // FakeMulti 가 호출하는 내부 진입점.
  applyZremrangebyscore(key: string, min: number, max: number): number {
    return this.zremrangebyscoreKey(key, min, max);
  }
  applyZadd(key: string, score: number, member: string): number {
    return this.zaddKey(key, score, member);
  }
  applyZrem(key: string, member: string): number {
    return this.zremKey(key, member);
  }
  applyZrangebyscore(key: string, min: string, max: string): string[] {
    return this.zrangebyscoreKey(key, min, max);
  }
  applyExpire(key: string, sec: number): number {
    this.keyTtl.set(key, sec);
    return 1;
  }
  applyDel(key: string): number {
    return this.delKey(key);
  }
}

type Op = () => unknown;

class FakeMulti {
  private ops: Op[] = [];
  constructor(private readonly r: FakeRedis) {}

  zremrangebyscore(key: string, min: number, max: number): this {
    this.ops.push(() => this.r.applyZremrangebyscore(key, min, max));
    return this;
  }
  zadd(key: string, score: number, member: string): this {
    this.ops.push(() => this.r.applyZadd(key, score, member));
    return this;
  }
  zrem(key: string, member: string): this {
    this.ops.push(() => this.r.applyZrem(key, member));
    return this;
  }
  zrangebyscore(key: string, min: string, max: string): this {
    this.ops.push(() => this.r.applyZrangebyscore(key, min, max));
    return this;
  }
  expire(key: string, sec: number): this {
    this.ops.push(() => this.r.applyExpire(key, sec));
    return this;
  }
  del(key: string): this {
    this.ops.push(() => this.r.applyDel(key));
    return this;
  }
  async exec(): Promise<Array<[Error | null, unknown]>> {
    return this.ops.map((op) => [null, op()]);
  }
}

function makeService(initialNow = 1_000_000): {
  svc: TypingService;
  redis: FakeRedis;
  setNow: (n: number) => void;
} {
  let now = initialNow;
  const redis = new FakeRedis(() => now);
  const svc = new TypingService(redis as unknown as Redis, () => Promise.resolve(now));
  return { svc, redis, setNow: (n) => (now = n) };
}

describe('TypingService ZSET 유저별 만료 (FR-RT-17)', () => {
  it('ping 은 채널 ZSET 에 사용자를 추가하고 capped 목록을 반환', async () => {
    const { svc } = makeService();
    const out = await svc.ping(A, CH);
    expect(out).toEqual([A]);
  });

  it('스로틀 창 안의 재ping 은 null 반환(중복 emit 억제)', async () => {
    const { svc } = makeService();
    expect(await svc.ping(A, CH)).toEqual([A]);
    // 같은 (user, channel) 즉시 재ping → 스로틀 키 살아 있음.
    expect(await svc.ping(A, CH)).toBeNull();
  });

  it('A 가 멈춰 만료돼도 B 의 ping 이 A 를 stale 하게 살리지 않음', async () => {
    // 핵심 회귀: 종전 SET 구현은 ping 마다 채널키 전체 TTL 을 리셋해 A 가
    // stale 하게 남았습니다. ZSET 유저별 score 만료로 A 는 자기 만료 시각에
    // 사라집니다.
    const { svc, setNow } = makeService(1_000_000);
    await svc.ping(A, CH); // A 만료 = 1_000_000 + 10_000 = 1_010_000
    setNow(1_005_000);
    await svc.ping(B, CH); // B 만료 = 1_015_000. A 는 아직 유효.
    expect((await svc.currentlyTyping(CH)).sort()).toEqual([A, B].sort());

    // A 의 만료 시각을 지난 시점에 B 가 다시 입력. A 는 ZSET 에서 사라져야 함.
    setNow(1_012_000); // A(1_010_000) 만료, B(1_015_000) 유효
    // B 스로틀 창(3s)이 지나도록 B 만료를 갱신하려면 새 ping 필요 — 스로틀은
    // 1_005_000+3000=1_008_000 이후 해제됨.
    const out = await svc.ping(B, CH);
    expect(out).not.toBeNull();
    expect(out).not.toContain(A);
    expect(out).toContain(B);
    // currentlyTyping 도 A 제외.
    expect(await svc.currentlyTyping(CH)).not.toContain(A);
  });

  it('currentlyTyping 은 만료 멤버를 lazy GC 한다', async () => {
    const { svc, redis, setNow } = makeService(1_000_000);
    await svc.ping(A, CH); // 만료 1_010_000
    expect(redis.rawZcard(`typing:channel:${CH}`)).toBe(1);
    setNow(1_020_000); // A 만료
    expect(await svc.currentlyTyping(CH)).toEqual([]);
    // lazy GC 로 ZSET 비워짐.
    expect(redis.rawZcard(`typing:channel:${CH}`)).toBe(0);
  });

  it('stop 은 사용자를 ZSET 에서 제거하고 changed=true', async () => {
    const { svc, setNow } = makeService(1_000_000);
    await svc.ping(A, CH);
    setNow(1_004_000); // 스로틀 해제 이후
    await svc.ping(B, CH);
    const res = await svc.stop(A, CH);
    expect(res.changed).toBe(true);
    expect(res.members).not.toContain(A);
    expect(res.members).toContain(B);
  });

  it('stop 미존재 사용자는 changed=false (idempotent)', async () => {
    const { svc } = makeService();
    const res = await svc.stop(A, CH);
    expect(res.changed).toBe(false);
  });

  it('dropForUser 는 여러 채널에서 제거된 channelId 만 반환', async () => {
    const { svc } = makeService(1_000_000);
    await svc.ping(A, 'ch-1');
    await svc.ping(A, 'ch-2');
    const changed = await svc.dropForUser(A, ['ch-1', 'ch-2', 'ch-3']);
    expect(changed.sort()).toEqual(['ch-1', 'ch-2'].sort());
  });

  // S32 (perf R-1): ping/stop 의 멤버 조회를 단일 multi 에 묶어, 별도 round-trip
  // (종전 validMembers multi)을 제거했다. 주입 clock 을 쓰면 redis TIME 호출이
  // 없으므로, ping/stop 당 multi() 가 정확히 1회만 일어나는지(=중복 GC + 추가
  // round-trip 제거)를 가드한다.
  it('ping 은 단일 multi round-trip 으로 멤버까지 회수(perf R-1)', async () => {
    const { svc, redis } = makeService(1_000_000);
    redis.multiCount = 0;
    const out = await svc.ping(A, CH);
    expect(out).toEqual([A]);
    expect(redis.multiCount).toBe(1);
  });

  it('stop 은 단일 multi round-trip 으로 멤버까지 회수(perf R-1)', async () => {
    const { svc, redis, setNow } = makeService(1_000_000);
    await svc.ping(A, CH);
    setNow(1_004_000); // 스로틀 해제 이후
    await svc.ping(B, CH);
    redis.multiCount = 0;
    const res = await svc.stop(A, CH);
    expect(res.changed).toBe(true);
    expect(res.members).not.toContain(A);
    expect(res.members).toContain(B);
    expect(redis.multiCount).toBe(1);
  });

  it('capVisible: 4명 이상이면 와이어는 최대 3 (priority 고정)', async () => {
    const { svc, setNow } = makeService(1_000_000);
    // A,B,C,D 가 각각 한 번씩 입력(user 별 스로틀 키라 같은 tick 도 충돌 없음).
    // TTL 10s 안이라 4명 모두 ZSET 유효.
    setNow(1_000_000);
    expect(await svc.ping(A, CH)).not.toBeNull();
    expect(await svc.ping(B, CH)).not.toBeNull();
    expect(await svc.ping(C, CH)).not.toBeNull();
    // D 를 priority 로 ping → 4명 후보 중 와이어는 3으로 cap, D 슬롯 보장.
    const out = await svc.ping(D, CH);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(3);
    expect(out).toContain(D);
  });
});
