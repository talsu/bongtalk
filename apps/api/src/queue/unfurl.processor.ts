import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { normalizeUrl, type MessageEmbedDto } from '@qufox/shared-types';
import { PrismaService } from '../prisma/prisma.module';
import { OutboxService } from '../common/outbox/outbox.service';
import { LinksService } from '../links/links.service';
import { OgImageFetcher } from '../links/og-image-fetcher';
import { ssrfGuard } from '../links/ssrf-guard';
import { toMessageEmbedDto, MESSAGE_EMBED_UPDATED_EVENT } from '../links/message-embed.mapper';
import { UNFURL_QUEUE, UNFURL_CONCURRENCY, type UnfurlJobData } from './unfurl-queue.constants';

/**
 * S60 (D11 / FR-AM-13/14/15/16 · FR-RC07/08/09/21): 링크 unfurl worker(BullMQ in-process).
 *
 * 메시지 발화 트랜잭션과 분리된 fire-and-forget 처리(전송 실패 영향 0). concurrency 2 로
 * 고volume 메시지 발화에서 외부 HTTP fetch 가 NAS Redis/네트워크를 압박하지 않게 한다.
 *
 * 잡당 절차(URL 마다 반복, cap 은 enqueue 측에서 적용됨):
 *   (1) 메시지 생존 확인(soft-delete/hard-delete 면 전체 skip — 카드 무의미).
 *   (2) normalizeUrl → cacheKey(64 hex sha256). 동일 메시지·cacheKey 가 이미 있으면 skip
 *       (멱등 재처리 — DB @@unique(messageId, cacheKey)).
 *   (3) Redis 캐시(linkembed:{cacheKey}) hit 면 fetch 생략하고 그 결과 사용(FR-RC09).
 *   (4) miss 면 ssrfGuard(사설/loopback/메타데이터 차단) → LinksService.fetchAndParse
 *       (timeout 5s · redirect 5회 · 각 hop SSRF 재검증) → Redis 1800s 적재.
 *   (5) OG 이미지가 있으면 OgImageFetcher(소켓레벨 IP 재검증 + image/* 강제 + MinIO 저장).
 *   (6) MessageEmbed upsert(messageId, cacheKey 충돌 시 갱신).
 *   (7) 잡의 모든 URL 처리 후, 해당 메시지의 비-suppress embed 전체 스냅샷을
 *       message.embed.updated outbox 이벤트로 1회 발행(channel 룸 fanout · idempotent replace).
 *
 * WorkerHost lifecycle 은 @nestjs/bullmq 가 관리한다(graceful shutdown 자동).
 */
@Processor(UNFURL_QUEUE, { concurrency: UNFURL_CONCURRENCY })
export class UnfurlProcessor extends WorkerHost {
  private readonly logger = new Logger(UnfurlProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly links: LinksService,
    private readonly ogImage: OgImageFetcher,
  ) {
    super();
  }

  async process(job: Job<UnfurlJobData>): Promise<void> {
    const { messageId, channelId, urls } = job.data;
    if (!Array.isArray(urls) || urls.length === 0) return;

    // (1) 메시지 생존 확인. 삭제됐으면 카드 무의미 — 전체 skip.
    const msg = await this.prisma.message.findUnique({
      where: { id: messageId },
      select: { id: true, deletedAt: true, channelId: true },
    });
    if (!msg || msg.deletedAt !== null) {
      this.logger.debug(`[unfurl] skip (message gone/deleted) msg=${messageId}`);
      return;
    }

    let touched = false;
    const seenCacheKeys = new Set<string>();
    for (const rawUrl of urls) {
      const normalized = normalizeUrl(rawUrl);
      const cacheKey = this.links.embedCacheKey(rawUrl);
      // 잡 내 동일 정규화 URL 중복 제거(extractMessageUrls 가 이미 dedupe 하지만 방어).
      if (seenCacheKeys.has(cacheKey)) continue;
      seenCacheKeys.add(cacheKey);

      try {
        const handled = await this.processOneUrl(messageId, rawUrl, normalized, cacheKey);
        touched = touched || handled;
      } catch (err) {
        // 단일 URL 실패가 잡 전체(다른 URL)를 막지 않도록 격리한다.
        this.logger.warn(
          `[unfurl] url failed msg=${messageId} url=${rawUrl.slice(0, 200)}: ${String(err).slice(0, 160)}`,
        );
      }
    }

    if (touched) {
      await this.emitEmbedUpdated(messageId, channelId);
    }
  }

  /**
   * 단일 URL 을 unfurl 해 MessageEmbed 를 upsert 한다. 새로 만들었거나 갱신했으면 true.
   * SSRF reject(사설/loopback 등)는 false(저장 안 함 — 카드 미생성).
   */
  private async processOneUrl(
    messageId: string,
    rawUrl: string,
    normalized: string,
    cacheKey: string,
  ): Promise<boolean> {
    // (3) Redis 캐시 우선 — hit 면 fetch 생략(FR-RC09).
    let preview = await this.links.getCachedByKey(cacheKey);
    if (!preview) {
      // (4) SSRF 검증 후 fetch+parse. reject 면 카드 미생성.
      const guard = await ssrfGuard(normalized);
      if (!guard.ok) {
        this.logger.debug(`[unfurl] ssrf reject msg=${messageId} reason=${guard.reason}`);
        return false;
      }
      preview = await this.links.fetchAndParse(guard.url.toString());
      await this.links.cachePreview(normalized, preview);
    }

    // 2xx 가 아니거나 메타가 전무하면 카드 미생성(빈 카드 방지).
    const isOk = preview.statusCode >= 200 && preview.statusCode < 300;
    if (!isOk || (!preview.title && !preview.description && !preview.image)) {
      return false;
    }

    // (5) OG 이미지 fetch + MinIO 저장(소켓레벨 IP 재검증 · image/* 강제). 실패/없음은 null.
    let imageKey: string | null = null;
    if (preview.image) {
      const stored = await this.ogImage.fetchAndStore(preview.image);
      imageKey = stored?.imageKey ?? null;
    }

    // (6) upsert. 동일 (messageId, cacheKey) 충돌 시 메타 갱신(재unfurl).
    await this.prisma.messageEmbed.upsert({
      where: { messageId_cacheKey: { messageId, cacheKey } },
      create: {
        messageId,
        url: rawUrl,
        normalizedUrl: normalized,
        cacheKey,
        title: preview.title,
        description: preview.description,
        siteName: preview.siteName,
        imageKey,
        statusCode: preview.statusCode,
        fetchedAt: new Date(preview.fetchedAt),
      },
      update: {
        url: rawUrl,
        normalizedUrl: normalized,
        title: preview.title,
        description: preview.description,
        siteName: preview.siteName,
        imageKey,
        statusCode: preview.statusCode,
        fetchedAt: new Date(preview.fetchedAt),
        // 재unfurl 은 suppress 를 해제하지 않는다(작성자/모더레이터 의도 존중) — 그대로 둔다.
      },
    });
    return true;
  }

  /**
   * 메시지의 비-suppress embed 전체 스냅샷을 message.embed.updated outbox 이벤트로
   * 발행한다(channel 룸 fanout · idempotent replace). best-effort — 실패해도 throw 하지
   * 않는다(DB 가 진실원 · 클라가 list 재조회로 자가 치유).
   */
  private async emitEmbedUpdated(messageId: string, channelId: string): Promise<void> {
    const rows = await this.prisma.messageEmbed.findMany({
      where: { messageId, suppressedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    const embeds: MessageEmbedDto[] = rows.map((r) => toMessageEmbedDto(r));
    try {
      await this.outbox.record(null, {
        aggregateType: 'Message',
        aggregateId: messageId,
        eventType: MESSAGE_EMBED_UPDATED_EVENT,
        payload: { channelId, messageId, embeds },
      });
    } catch (err) {
      this.logger.warn(
        `[unfurl] embed_updated outbox record failed msg=${messageId}: ${String(err).slice(0, 160)}`,
      );
    }
  }
}
