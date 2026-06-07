import { Injectable, Logger } from '@nestjs/common';
import type { IncomingWebhook } from '@prisma/client';
import {
  isReservedBotName,
  isRenderableRichEmbed,
  normalizeEmbedColor,
  type CreateWebhookRequest,
  type IncomingWebhookPayload,
  type WebhookCreatedResponse,
  type WebhookListResponse,
  type WebhookSummary,
} from '@qufox/shared-types';
import { PrismaService } from '../../prisma/prisma.module';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';
import { RateLimitService } from '../../auth/services/rate-limit.service';
import { MessagesService } from '../../messages/messages.service';
import { generateRawToken, hashToken, safeTokenEquals } from './webhook-token.util';

/**
 * S84a (D16 / FR-RC11) — 인커밍 웹훅 / 봇 메시지 도메인 서비스.
 *
 * 두 표면을 담당한다:
 *   1) 관리(MANAGE_WEBHOOKS): create / list / rotate / revoke. 토큰 평문은
 *      create/rotate 응답에서 1회만 노출하고 DB 엔 sha256(rawToken) 64-hex 만 저장한다.
 *   2) 인커밍 게시(verifyAndPost): 토큰 인증(timingSafeEqual)으로 BOT 메시지를 게시.
 *
 * 예약어(system/qufox/admin)는 name/botDisplayName/요청 username 으로 거부(422).
 * revoke 는 행 삭제가 아니라 revokedAt 표식(감사 보존) — 폐기/회전 토큰 POST 는 403.
 */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rateLimit: RateLimitService,
    private readonly messages: MessagesService,
  ) {}

  // ── 매핑 ─────────────────────────────────────────────────────────────────────

  /** IncomingWebhook row → WebhookSummary(토큰 해시/평문 절대 비노출). */
  private toSummary(w: IncomingWebhook): WebhookSummary {
    return {
      id: w.id,
      workspaceId: w.workspaceId,
      channelId: w.channelId,
      name: w.name,
      botDisplayName: w.botDisplayName,
      avatarUrl: w.avatarUrl,
      createdBy: w.createdBy,
      createdAt: w.createdAt.toISOString(),
      rotatedAt: w.rotatedAt?.toISOString() ?? null,
      revokedAt: w.revokedAt?.toISOString() ?? null,
      lastUsedAt: w.lastUsedAt?.toISOString() ?? null,
    };
  }

  /** create/rotate 응답: 메타 + 평문 토큰 1회 + 게시 URL(상대). */
  private toCreatedResponse(w: IncomingWebhook, rawToken: string): WebhookCreatedResponse {
    return {
      ...this.toSummary(w),
      token: rawToken,
      // S84a 리뷰 fix-forward (security MEDIUM-3): postUrl 에 토큰 평문을 쿼리로 박지
      // 않는다 — 쿼리스트링 토큰은 proxy/access 로그·브라우저 히스토리·Referer 로 새기
      // 쉽다. bare 경로만 안내하고, 권장 전송은 `Authorization: Bearer <token>` 헤더다
      // (컨트롤러는 호환을 위해 `?token=` 도 계속 받지만 광고하지 않는다).
      postUrl: `/webhooks/${w.id}`,
    };
  }

  /** name/botDisplayName 예약어 가드(422). */
  private assertNotReserved(...names: Array<string | undefined | null>): void {
    for (const n of names) {
      if (n && isReservedBotName(n)) {
        throw new DomainError(
          ErrorCode.WEBHOOK_NAME_RESERVED,
          `"${n}" 은(는) 예약어라 봇 이름으로 쓸 수 없습니다`,
        );
      }
    }
  }

  // ── 관리 ─────────────────────────────────────────────────────────────────────

  /**
   * 웹훅 생성. channelId 가 해당 워크스페이스 소속(비삭제)인지 검증하고, 예약어를
   * 거부한 뒤 평문 토큰을 생성해 sha256 만 저장한다. 응답은 평문 토큰 1회 + 게시 URL.
   */
  async create(
    workspaceId: string,
    createdBy: string,
    req: CreateWebhookRequest,
  ): Promise<WebhookCreatedResponse> {
    this.assertNotReserved(req.name, req.botDisplayName);
    // 채널이 이 워크스페이스 소속(비삭제)인지 확인 — 타 워크스페이스 채널로의 게시 차단.
    const channel = await this.prisma.channel.findFirst({
      where: { id: req.channelId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!channel) {
      throw new DomainError(ErrorCode.CHANNEL_NOT_FOUND, 'channel not found in this workspace');
    }
    const rawToken = generateRawToken();
    const created = await this.prisma.incomingWebhook.create({
      data: {
        workspaceId,
        channelId: req.channelId,
        name: req.name,
        botDisplayName: req.botDisplayName ?? null,
        avatarUrl: req.avatarUrl ?? null,
        tokenHash: hashToken(rawToken),
        createdBy,
      },
    });
    return this.toCreatedResponse(created, rawToken);
  }

  /** 워크스페이스 웹훅 목록(토큰/해시 비노출). 폐기된 것도 포함(감사 가시성). */
  async list(workspaceId: string): Promise<WebhookListResponse> {
    const rows = await this.prisma.incomingWebhook.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });
    return { items: rows.map((w) => this.toSummary(w)) };
  }

  /**
   * 토큰 회전. 새 평문 토큰을 생성해 sha256 으로 교체하고 rotatedAt 을 찍는다(기존
   * 토큰 즉시 무효). revoke 된 웹훅은 회전 불가(404 — 폐기 행은 관리 대상에서 제외).
   * 응답은 새 평문 토큰 1회 + 게시 URL.
   */
  async rotate(workspaceId: string, webhookId: string): Promise<WebhookCreatedResponse> {
    const existing = await this.findManageable(workspaceId, webhookId);
    const rawToken = generateRawToken();
    const updated = await this.prisma.incomingWebhook.update({
      where: { id: existing.id },
      data: { tokenHash: hashToken(rawToken), rotatedAt: new Date() },
    });
    return this.toCreatedResponse(updated, rawToken);
  }

  /**
   * 웹훅 폐기(revoke). 행 삭제가 아니라 revokedAt 을 찍어 감사 추적을 보존한다 —
   * 이후 인커밍 POST 는 403. 이미 폐기된 웹훅은 idempotent(다시 404 가 아니라 no-op).
   */
  async revoke(workspaceId: string, webhookId: string): Promise<void> {
    // 폐기 멱등: 존재만 확인하고(타 워크스페이스/미존재 → 404) 이미 폐기면 그대로 둔다.
    const existing = await this.prisma.incomingWebhook.findFirst({
      where: { id: webhookId, workspaceId },
      select: { id: true, revokedAt: true },
    });
    if (!existing) {
      throw new DomainError(ErrorCode.WEBHOOK_NOT_FOUND, 'webhook not found');
    }
    if (existing.revokedAt) return;
    await this.prisma.incomingWebhook.update({
      where: { id: existing.id },
      data: { revokedAt: new Date() },
    });
  }

  /** 관리(rotate)용 조회: 워크스페이스 소속 + 비폐기. 아니면 404. */
  private async findManageable(workspaceId: string, webhookId: string): Promise<IncomingWebhook> {
    const w = await this.prisma.incomingWebhook.findFirst({
      where: { id: webhookId, workspaceId, revokedAt: null },
    });
    if (!w) {
      throw new DomainError(ErrorCode.WEBHOOK_NOT_FOUND, 'webhook not found');
    }
    return w;
  }

  // ── 인커밍 게시 ──────────────────────────────────────────────────────────────

  /**
   * 인커밍 토큰 게시. 멤버 가드 없이 토큰 자체가 인증이다.
   *   1) 웹훅 조회(미존재 → INVALID_TOKEN 403, 존재 노출 회피).
   *   2) safeTokenEquals(timingSafeEqual) 불일치 → INVALID_TOKEN 403.
   *   3) (토큰 일치 후에야) revoke 여부 → REVOKED 403.
   *   4) 요청 username 예약어 → NAME_RESERVED 422.
   *   5) 표시 이름/아바타 해석(요청 → 웹훅 botDisplayName/name, 요청 → 웹훅 avatarUrl).
   *   6) BOT 메시지 생성 + lastUsedAt 갱신.
   * rate-limit 은 IP·웹훅·채널 단위로 무차별 대입/폭주를 막는다.
   *
   * S84a 리뷰 fix-forward (security HIGH-1): revoke 검사를 **토큰 검증 뒤**로 옮겼다.
   * 종전엔 revoke 를 먼저 검사해, 토큰 없이 webhookId 만 아는 호출자가 REVOKED vs
   * INVALID_TOKEN 응답 차이로 "그 id 가 존재하고 폐기됐는지"를 알아내는 존재/라이프
   * 사이클 oracle 이 있었다. 토큰이 일치하기 전에는 어떤 상태도 구분하지 않는다.
   */
  async verifyAndPost(
    webhookId: string,
    rawToken: string,
    payload: IncomingWebhookPayload,
    // S84a 리뷰 fix-forward (security LOW-7): @Public 라우트에 전역 IP throttle 이 없어,
    // 컨트롤러가 전달한 클라이언트 IP 로 per-IP 버킷을 먼저 건다(NFR "IP + User 이중").
    // per-id 버킷만으로는 id 를 회전하는 단일 소스의 총량을 못 막는다.
    clientIp?: string,
  ): Promise<{ messageId: string; channelId: string; createdAt: string }> {
    // 무차별 대입/폭주 방어: 토큰 검증 전에 IP·웹훅 단위 rate-limit 을 먼저 건다(미존재
    // id 도 동일 비용). 채널 폭주 방어는 검증 통과 후(유효 토큰 한정)에 건다.
    await this.rateLimit.enforce([
      ...(clientIp ? [{ key: `webhook:post:ip:${clientIp}`, windowSec: 60, max: 300 }] : []),
      { key: `webhook:post:wh:${webhookId}`, windowSec: 60, max: 120 },
    ]);

    const webhook = await this.prisma.incomingWebhook.findUnique({ where: { id: webhookId } });
    // 미존재 웹훅은 INVALID_TOKEN(404 가 아니라 403)으로 통일 — 웹훅 존재 여부 oracle 차단.
    if (!webhook) {
      throw new DomainError(ErrorCode.WEBHOOK_INVALID_TOKEN, 'invalid webhook token');
    }
    // HIGH-1: 토큰을 먼저 상수시간 검증한다. 불일치는 revoke 여부와 무관하게 INVALID_TOKEN.
    if (!safeTokenEquals(rawToken, webhook.tokenHash)) {
      throw new DomainError(ErrorCode.WEBHOOK_INVALID_TOKEN, 'invalid webhook token');
    }
    // 토큰이 일치한 뒤에만 폐기 상태를 구분해 알려준다(유효 토큰 보유자에게만 의미 있는 정보).
    if (webhook.revokedAt) {
      throw new DomainError(ErrorCode.WEBHOOK_REVOKED, 'webhook revoked');
    }
    // 요청 username 예약어 거부(웹훅 name/botDisplayName 은 create 시 이미 검증됨).
    this.assertNotReserved(payload.username);

    // 채널 단위 폭주 방어(유효 토큰 한정).
    await this.rateLimit.enforce([
      { key: `webhook:post:ch:${webhook.channelId}`, windowSec: 60, max: 240 },
    ]);

    // 표시 이름/아바타 해석 — 메시지에 자족적으로 저장(웹훅 삭제 후에도 보존).
    const botUsername = payload.username ?? webhook.botDisplayName ?? webhook.name;
    const botAvatarUrl = payload.avatar_url ?? webhook.avatarUrl ?? null;

    // S84b (FR-RC12): rich embed 정규화 — 렌더할 내용이 없는 빈 embed 제거 + color 를
    // `#rrggbb` 정규형으로. 스키마(RichEmbedArraySchema)가 이미 캡·URL scheme·fields≤25
    // 를 강제했으므로 여기선 표시 정규화만 한다.
    const richEmbeds = (payload.embeds ?? [])
      .filter(isRenderableRichEmbed)
      .map((e) => (e.color ? { ...e, color: normalizeEmbedColor(e.color) } : e));

    const row = await this.messages.createBotMessage({
      workspaceId: webhook.workspaceId,
      channelId: webhook.channelId,
      authorId: webhook.createdBy,
      webhookId: webhook.id,
      // embed-only 메시지는 content 가 없을 수 있다(payload refine 이 content|embeds 보장).
      content: payload.content ?? '',
      botUsername,
      botAvatarUrl,
      richEmbeds,
    });

    // lastUsedAt 갱신(베스트-에포트 — 실패해도 게시 자체는 성공). 표식용이라 트랜잭션 분리.
    await this.prisma.incomingWebhook
      .update({ where: { id: webhook.id }, data: { lastUsedAt: new Date() } })
      .catch((err) =>
        this.logger.warn(
          `[webhook] lastUsedAt update failed wh=${webhook.id} err=${String(err).slice(0, 200)}`,
        ),
      );

    return {
      messageId: row.id,
      channelId: row.channelId,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
