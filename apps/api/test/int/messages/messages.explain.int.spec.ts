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
  it('initial DESC query — Index Scan on Message_channelId_createdAt_id_idx', async () => {
    const rows = await env.prisma.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
      `EXPLAIN (ANALYZE, BUFFERS)
         SELECT id FROM "Message"
          WHERE "channelId" = $1::uuid AND "deletedAt" IS NULL
          ORDER BY "createdAt" DESC, id DESC
          LIMIT 50`,
      stack.channelId,
    );
    const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
    expect(plan).toMatch(/Index Scan|Index Only Scan/);
    expect(plan).not.toMatch(/\bSort\b/);
  });

  it('before cursor query uses the same index with row-value comparison', async () => {
    const latest = await env.prisma.message.findFirst({
      where: { channelId: stack.channelId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const rows = await env.prisma.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
      `EXPLAIN (ANALYZE, BUFFERS)
         SELECT id FROM "Message"
          WHERE "channelId" = $1::uuid AND "deletedAt" IS NULL
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
