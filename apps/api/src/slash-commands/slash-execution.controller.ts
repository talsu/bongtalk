import { Body, Controller, Inject, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import type Redis from 'ioredis';
import {
  ExecuteSlashCommandRequestSchema,
  type ExecuteSlashCommandResponse,
} from '@qufox/shared-types';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import {
  CurrentMember,
  CurrentMemberPayload,
} from '../workspaces/decorators/current-member.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspaceMemberGuard } from '../workspaces/guards/workspace-member.guard';
import { ChannelAccessGuard } from '../channels/guards/channel-access.guard';
import { RateLimitService } from '../auth/services/rate-limit.service';
import { REDIS } from '../redis/redis.module';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { SlashExecutionService } from './slash-execution.service';

/**
 * S80 (D15 / FR-SC-04·05·06) — 슬래시 커맨드 실행 REST surface.
 *
 * POST /workspaces/:wsId/channels/:chid/slash-commands/execute
 *   가드 체인: JwtAuthGuard(전역) → WorkspaceMemberGuard(:wsId, 비멤버 404) →
 *   ChannelAccessGuard(:chid — req.params.chid 재사용). 멱등성은 Redis
 *   `slash-idem:{userId}:{idempotencyKey}` (TTL 24h)로 1차 dedup 하고, IN_CHANNEL
 *   경로는 MessagesService.send 의 (authorId, idempotencyKey) UNIQUE 가 2차 방어선이다.
 *   rate 30/min/user. EPHEMERAL 응답은 HTTP 동기 본문으로 돌려준다(WS emit 옵션은 이번 OUT).
 */
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, ChannelAccessGuard)
@Controller('workspaces/:wsId/channels/:chid/slash-commands')
export class SlashExecutionController {
  private readonly IDEM_TTL_SEC = 24 * 60 * 60;

  constructor(
    private readonly svc: SlashExecutionService,
    private readonly rate: RateLimitService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Post('execute')
  async execute(
    @Param('wsId', new ParseUUIDPipe()) _wsId: string,
    @Param('chid', new ParseUUIDPipe()) chid: string,
    @CurrentUser() user: CurrentUserPayload,
    @CurrentMember() member: CurrentMemberPayload,
    @Body() body: unknown,
  ): Promise<ExecuteSlashCommandResponse> {
    const parsed = ExecuteSlashCommandRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    // S66 (FR-W05a): 미인증 계정은 IN_CHANNEL 게시(메시지 생성)를 못 하므로 일괄 차단.
    if (!user.emailVerified) {
      throw new DomainError(ErrorCode.EMAIL_NOT_VERIFIED, '이메일 인증 후 사용할 수 있습니다');
    }
    await this.rate.enforce([{ key: `slash:exec:u:${user.id}`, windowSec: 60, max: 30 }]);

    // 멱등성 1차: 같은 (userId, key) 가 24h 내 이미 처리됐으면 캐시된 응답을 그대로 반환한다.
    const idemKey = `slash-idem:${user.id}:${parsed.data.idempotencyKey}`;
    const cached = await this.readIdem(idemKey);
    if (cached) return cached;

    const result = await this.svc.execute({
      userId: user.id,
      workspaceId: member.workspaceId,
      channelId: chid,
      command: parsed.data.command,
      text: parsed.data.text,
      idempotencyKey: parsed.data.idempotencyKey,
    });
    // S80 reviewer H2 fix: 에러 EPHEMERAL(파싱 실패 등)은 캐시하지 않는다 — 캐시하면 같은
    // 키로 고쳐 재시도해도 24h 동안 stale 에러가 반환된다. 성공/IN_CHANNEL 만 멱등 캐시한다.
    const isErrorEphemeral = result.responseType === 'EPHEMERAL' && result.error === true;
    if (!isErrorEphemeral) await this.writeIdem(idemKey, result);
    return result;
  }

  private async readIdem(key: string): Promise<ExecuteSlashCommandResponse | null> {
    try {
      const raw = await this.redis.get(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as ExecuteSlashCommandResponse;
      return parsed;
    } catch {
      return null;
    }
  }

  private async writeIdem(key: string, value: ExecuteSlashCommandResponse): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', this.IDEM_TTL_SEC);
    } catch {
      // best-effort — 캐시 실패는 무해(IN_CHANNEL 은 send UNIQUE 가 2차 방어).
    }
  }
}
