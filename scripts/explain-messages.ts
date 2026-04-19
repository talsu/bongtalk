/**
 * Messages — EXPLAIN ANALYZE collector. Seeds a synthetic channel with N rows
 * and prints the planner output for the three representative pagination
 * queries. Output is captured verbatim into docs/tasks/004-message.md so a
 * reviewer can verify that no Sort node has slipped back in.
 *
 * Usage:
 *   DATABASE_URL=... pnpm exec tsx scripts/explain-messages.ts [count=5000]
 */
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

async function main(): Promise<void> {
  const count = Number(process.argv[2] ?? 5000);
  const prisma = new PrismaClient();

  // Use an existing channel if one is reachable; otherwise seed a disposable
  // workspace + channel just for the EXPLAIN run. Staying read-only lets this
  // script run against the dev DB without leaving detritus.
  const channel = await prisma.channel.findFirst({ select: { id: true, workspaceId: true } });
  if (!channel) {
    console.error('no channel in DB — seed one first');
    process.exit(2);
  }
  const author = await prisma.user.findFirst({ select: { id: true } });
  if (!author) {
    console.error('no user in DB — seed one first');
    process.exit(2);
  }

  const existing = await prisma.message.count({ where: { channelId: channel.id } });
  if (existing < count) {
    const base = Date.now();
    const batch = 1000;
    for (let i = 0; i < count - existing; i += batch) {
      const rows = Array.from({ length: Math.min(batch, count - existing - i) }, (_, k) => ({
        id: randomUUID(),
        channelId: channel.id,
        authorId: author.id,
        content: `explain #${(i + k).toString().padStart(5, '0')}`,
        contentPlain: `explain #${(i + k).toString().padStart(5, '0')}`,
        createdAt: new Date(base - (count - existing - i - k) * 1000),
      }));
      await prisma.message.createMany({ data: rows });
    }
  }
  await prisma.$executeRawUnsafe('ANALYZE "Message"');

  const latest = await prisma.message.findFirst({
    where: { channelId: channel.id },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });

  const queries: Array<{ label: string; sql: string; params: unknown[] }> = [
    {
      label: 'Q1: initial page (newest 50, DESC)',
      sql: `EXPLAIN (ANALYZE, BUFFERS)
              SELECT id FROM "Message"
               WHERE "channelId" = $1::uuid AND "deletedAt" IS NULL
               ORDER BY "createdAt" DESC, id DESC
               LIMIT 50`,
      params: [channel.id],
    },
    {
      label: 'Q2: before cursor (row comparison)',
      sql: `EXPLAIN (ANALYZE, BUFFERS)
              SELECT id FROM "Message"
               WHERE "channelId" = $1::uuid AND "deletedAt" IS NULL
                 AND ("createdAt", id) < ($2::timestamp, $3::uuid)
               ORDER BY "createdAt" DESC, id DESC
               LIMIT 50`,
      params: [channel.id, latest!.createdAt, latest!.id],
    },
    {
      label: 'Q3: single-message lookup (PK)',
      sql: `EXPLAIN (ANALYZE, BUFFERS)
              SELECT id FROM "Message" WHERE id = $1::uuid`,
      params: [latest!.id],
    },
  ];

  for (const q of queries) {
    console.log(`\n==== ${q.label} ====`);
    const rows = await prisma.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(q.sql, ...q.params);
    for (const r of rows) console.log(r['QUERY PLAN']);
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
