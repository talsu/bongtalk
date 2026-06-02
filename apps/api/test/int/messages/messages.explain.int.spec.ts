import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MsgIntEnv, seedMessageStack, seedRawMessages, setupMsgIntEnv } from './helpers';

let env: MsgIntEnv;
let stack: Awaited<ReturnType<typeof seedMessageStack>>;

beforeAll(async () => {
  env = await setupMsgIntEnv();
  stack = await seedMessageStack(env.baseUrl);
  // Warm the table. 5k rows is plenty for the planner to pick a real plan
  // rather than Seq-Scan-falling-through.
  await seedRawMessages(env.prisma, {
    channelId: stack.channelId,
    authorId: stack.member.userId,
    count: 5000,
  });
  // Force fresh stats so the planner sees the real row count.
  await env.prisma.$executeRawUnsafe('ANALYZE "Message"');
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

describe('Message pagination uses an Index Scan (no Sort)', () => {
  // S33 fix-forward (MAJOR-3 / perf E): EXPLAIN 의 술어를 prod rawList 가
  // 실제로 발행하는 것과 정합시킨다. roots-only 채널 목록은 `parentMessageId
  // IS NULL` + S33 의 `("deletedAt" IS NULL OR "replyCount" > 0)` 필터를 쓴다
  // (답글 보유 deleted thread-root placeholder 유지 — FR-MSG-09 carryover).
  // 종전 테스트는 `deletedAt IS NULL` 단독을 써서 OR 필터의 플랜을 검증하지
  // 못하는 false-green 이었다. 이제 실제 술어로 갱신해 OR 필터가 partial index
  // `Message_channel_roots_idx` 위에서 Index Scan + bounded recheck 로 도는지
  // 확인한다.
  const ROOTS_FILTER = `"parentMessageId" IS NULL AND ("deletedAt" IS NULL OR "replyCount" > 0)`;

  it('initial DESC roots query — Index Scan (no Sort) with the real OR predicate', async () => {
    const rows = await env.prisma.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
      `EXPLAIN (ANALYZE, BUFFERS)
         SELECT id FROM "Message"
          WHERE "channelId" = $1::uuid AND ${ROOTS_FILTER}
          ORDER BY "createdAt" DESC, id DESC
          LIMIT 50`,
      stack.channelId,
    );
    const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
    expect(plan).toMatch(/Index Scan|Index Only Scan/);
    expect(plan).not.toMatch(/\bSort\b/);
    // partial roots index 가 선택되고 seq scan 으로 회귀하지 않는지 확인.
    expect(plan).not.toMatch(/Seq Scan on "Message"/i);
  });

  it('before cursor roots query uses the same index with row-value comparison', async () => {
    const latest = await env.prisma.message.findFirst({
      where: { channelId: stack.channelId, parentMessageId: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const rows = await env.prisma.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
      `EXPLAIN (ANALYZE, BUFFERS)
         SELECT id FROM "Message"
          WHERE "channelId" = $1::uuid AND ${ROOTS_FILTER}
            AND ("createdAt", id) < ($2::timestamp, $3::uuid)
          ORDER BY "createdAt" DESC, id DESC
          LIMIT 50`,
      stack.channelId,
      latest!.createdAt,
      latest!.id,
    );
    const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
    expect(plan).toMatch(/Index Scan|Index Only Scan/);
    expect(plan).not.toMatch(/\bSort\b/);
    expect(plan).not.toMatch(/Seq Scan on "Message"/i);
  });

  it('LATERAL replyParticipants subquery stays on an Index Scan (no Seq Scan)', async () => {
    // S33 fix-forward (perf F): aggregateThreadSummaries 의 내부 LATERAL —
    // 루트당 최근 distinct author(≤5). 내부 술어는 `parentMessageId = root
    // AND deletedAt IS NULL` + GROUP BY authorId + ORDER BY MAX(createdAt).
    // Seq Scan / 과도 Heap Fetch 가 아니라 replies 인덱스(parentMessageId,
    // createdAt) 위 Index Scan 으로 도는지 측정한다.
    const root = await env.prisma.message.findFirst({
      where: { channelId: stack.channelId, parentMessageId: null },
    });
    const rows = await env.prisma.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
      `EXPLAIN (ANALYZE, BUFFERS)
         SELECT r."authorId", MAX(r."createdAt") AS last_at
           FROM "Message" r
          WHERE r."parentMessageId" = $1::uuid
            AND r."deletedAt" IS NULL
          GROUP BY r."authorId"
          ORDER BY MAX(r."createdAt") DESC
          LIMIT 5`,
      root!.id,
    );
    const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
    expect(plan).not.toMatch(/Seq Scan on "Message"/i);
  });

  it('single-message lookup hits primary key', async () => {
    const pick = await env.prisma.message.findFirst({
      where: { channelId: stack.channelId },
    });
    const rows = await env.prisma.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
      `EXPLAIN (ANALYZE, BUFFERS)
         SELECT id FROM "Message" WHERE id = $1::uuid`,
      pick!.id,
    );
    const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
    expect(plan).toMatch(/Index Scan|Index Only Scan/);
  });
});
