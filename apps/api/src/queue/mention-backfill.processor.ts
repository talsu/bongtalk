import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { Prisma } from '@prisma/client';
import { extractMentionUserIds, MENTION_CHANNEL_RE } from '@qufox/shared-types';
import { PrismaService } from '../prisma/prisma.module';
import { processMrkdwn } from '../messages/mrkdwn-pipeline';
import {
  MENTION_BACKFILL_BATCH_SIZE,
  MENTION_BACKFILL_DONE_KEY,
  MENTION_BACKFILL_JOB,
  MENTION_BACKFILL_JOB_ID,
  MENTION_BACKFILL_JOB_OPTS,
  MENTION_BACKFILL_QUEUE,
} from './mention-backfill.constants';

/**
 * 071-M3 F10 — 멘션 토큰 백필 1회성 워커. 설계 근거는 constants 참조.
 *
 * 멱등성: 대상 prefilter 가 "contentAst 직렬화에 평문 멘션 토큰이 잔존"인데,
 * 재파싱 후 토큰은 mention 노드(userId 필드)로 바뀌어 `@{uuid}` 리터럴이
 * 사라지므로 같은 행이 두 번 잡히지 않는다(자연 멱등). 거기에 Redis 완료
 * 마커 + 고정 jobId 로 잡 수준 dedup 을 더한다.
 *
 * 안전:
 *  - 갱신은 raw SQL 로 contentAst/contentPlain 만 — Prisma update 는 @updatedAt
 *    을 자동 터치하고 version 은 편집 낙관잠금에 쓰이므로 금지.
 *  - 구값은 MentionBackfillBackup 에 ON CONFLICT DO NOTHING 적재(reversible).
 *  - 삭제 행(deletedAt) 스킵, 파싱 실패 행은 건너뛰고 카운트만 남긴다.
 *  - WS 미발송 — 라이브 캐시는 다음 refetch 에서 자연 수렴(표시 개선 전용).
 */
@Injectable()
@Processor(MENTION_BACKFILL_QUEUE)
export class MentionBackfillProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(MentionBackfillProcessor.name);

  constructor(
    @InjectQueue(MENTION_BACKFILL_QUEUE) private readonly queue: Queue,
    private readonly prisma: PrismaService,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    try {
      const client = await this.queue.client;
      const done = await client.get(MENTION_BACKFILL_DONE_KEY);
      if (done) return;
      await this.queue.add(
        MENTION_BACKFILL_JOB,
        {},
        {
          jobId: MENTION_BACKFILL_JOB_ID,
          ...MENTION_BACKFILL_JOB_OPTS,
        },
      );
      this.logger.log('mention-uuid backfill job enqueued');
    } catch (e) {
      // best-effort — Redis 일시 실패는 다음 부팅에서 재시도된다.
      this.logger.warn(`backfill enqueue skipped: ${(e as Error).message}`);
    }
  }

  async process(_job: Job): Promise<{ updated: number; skipped: number }> {
    let cursor = '00000000-0000-0000-0000-000000000000';
    let updated = 0;
    let skipped = 0;
    // contentAst 직렬화에 평문 토큰이 남은 행만 — mention 노드의 "userId":"<uuid>"
    // 에는 `@{`/`<#` 리터럴이 없어 자연 멱등 prefilter 가 된다.
    const tokenRe = String.raw`(@\{|<#)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\}|>)`;

    for (;;) {
      const rows = await this.prisma.$queryRaw<
        Array<{ id: string; contentRaw: string | null; content: string }>
      >(Prisma.sql`
        SELECT id, "contentRaw", content
        FROM "Message"
        WHERE id > ${cursor}::uuid
          AND "deletedAt" IS NULL
          AND "contentAst" IS NOT NULL
          AND "contentAst"::text ~ ${tokenRe}
        ORDER BY id
        LIMIT ${MENTION_BACKFILL_BATCH_SIZE}
      `);
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1]!.id;

      // 배치 단위 라벨 맵 — 추출된 user/channel id 를 일괄 조회해 mention 노드에
      // label(표시명)을 함께 박는다(send 경로의 labelMaps 와 동일 의미).
      const userIds = new Set<string>();
      const channelIds = new Set<string>();
      for (const r of rows) {
        const raw = r.contentRaw ?? r.content;
        for (const uid of extractMentionUserIds(raw)) userIds.add(uid);
        const chRe = new RegExp(MENTION_CHANNEL_RE.source, 'g');
        for (const m of raw.matchAll(chRe)) channelIds.add(m[1]!);
      }
      const users: Array<{ id: string; username: string }> = userIds.size
        ? await this.prisma.user.findMany({
            where: { id: { in: [...userIds] } },
            select: { id: true, username: true },
          })
        : [];
      const channels: Array<{ id: string; name: string }> = channelIds.size
        ? await this.prisma.channel.findMany({
            where: { id: { in: [...channelIds] } },
            select: { id: true, name: true },
          })
        : [];
      const userName = new Map<string, string>(users.map((u) => [u.id, u.username]));
      const channelName = new Map<string, string>(channels.map((c) => [c.id, c.name]));

      for (const row of rows) {
        const raw = row.contentRaw ?? row.content;
        let ast: unknown;
        let plain: string;
        try {
          const processed = processMrkdwn(raw, {
            mentionLabels: {
              user: (id) => userName.get(id),
              channel: (id) => channelName.get(id),
              role: () => undefined,
            },
          });
          ast = processed.contentAst;
          plain = processed.contentPlain;
        } catch (e) {
          skipped += 1;
          this.logger.warn(`backfill parse skip ${row.id}: ${(e as Error).message}`);
          continue;
        }
        // ★F11 리뷰 M-8: SELECT~UPDATE 사이에 사용자 편집이 끼어들 수 있다(수 초
        // 창) — 편집 경로는 contentAst 를 재파싱해 평문 토큰이 사라지므로,
        // prefilter(tokenRe)를 양쪽 문에 재단언하면 편집된 행은 자연 no-op 이
        // 된다(version/contentRaw 동등성 가드와 등가·더 단순).
        const [, changed] = await this.prisma.$transaction([
          this.prisma.$executeRaw(Prisma.sql`
            INSERT INTO "MentionBackfillBackup" ("message_id", "content_ast_old", "content_plain_old")
            SELECT id, "contentAst", "contentPlain" FROM "Message"
            WHERE id = ${row.id}::uuid AND "contentAst"::text ~ ${tokenRe}
            ON CONFLICT ("message_id") DO NOTHING
          `),
          this.prisma.$executeRaw(Prisma.sql`
            UPDATE "Message"
            SET "contentAst" = ${JSON.stringify(ast)}::jsonb,
                "contentPlain" = ${plain}
            WHERE id = ${row.id}::uuid AND "contentAst"::text ~ ${tokenRe}
          `),
        ]);
        if (changed === 1) {
          updated += 1;
        } else {
          // 동시 편집이 선행한 행 — 편집이 이미 올바른 AST 를 썼으므로 건너뜀.
          skipped += 1;
          this.logger.log(`backfill concurrent-edit skip ${row.id}`);
        }
      }
      this.logger.log(`mention backfill progress: updated=${updated} skipped=${skipped}`);
    }

    const client = await this.queue.client;
    await client.set(MENTION_BACKFILL_DONE_KEY, new Date().toISOString());
    this.logger.log(`mention backfill done: updated=${updated} skipped=${skipped}`);
    return { updated, skipped };
  }
}
