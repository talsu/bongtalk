import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspaceMemberGuard } from '../workspaces/guards/workspace-member.guard';
import { WorkspaceRoleGuard } from '../workspaces/guards/workspace-role.guard';
import { Roles } from '../workspaces/decorators/roles.decorator';
import {
  CurrentMember,
  CurrentMemberPayload,
} from '../workspaces/decorators/current-member.decorator';
import { RateLimitService } from '../auth/services/rate-limit.service';
import { CustomEmojiService } from './custom-emoji.service';
import { PresignEmojiUploadDto } from './dto/presign-emoji-upload.dto';

/**
 * task-037-D / S41 (D05): workspace emoji pack REST surface.
 *
 * - Any member can GET /list + react with existing emoji. Picker opens
 *   are cached by React Query (10-min staleTime) so the unrated GET is
 *   not the hot path; if a future client bypasses the cache we'll
 *   revisit adding a bucket.
 * - Upload(presign/finalize) 은 OWNER/ADMIN only (canMemberUpload 토글은
 *   S41 carryover — 기본 ADMIN+ 게이트 유지). Upload 은 10/min per
 *   (workspace, user).
 * - S41 (FR-EM04): 삭제는 더 이상 ADMIN 하드게이트가 아니다 — 업로드 본인
 *   (MEMBER 포함) 또는 OWNER/ADMIN 이면 허용한다. 그래서 DELETE 라우트는
 *   @Roles 를 떼어 멤버까지 통과시키고, 서비스가 (callerId, role) 로 분기한다.
 *   delete 는 30/min per user — cheap ops, bulk cleanup stays practical.
 */
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, WorkspaceRoleGuard)
@Controller('workspaces/:wsId/emojis')
export class CustomEmojiController {
  constructor(
    private readonly svc: CustomEmojiService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Get()
  async list(@Param('wsId', new ParseUUIDPipe()) wsId: string) {
    return { items: await this.svc.list(wsId) };
  }

  @Post('presign-upload')
  @Roles('ADMIN')
  async presign(
    @Param('wsId', new ParseUUIDPipe()) wsId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: PresignEmojiUploadDto,
  ) {
    await this.rateLimit.enforce([
      { key: `emoji:upload:${wsId}:${user.id}`, windowSec: 60, max: 10 },
    ]);
    return this.svc.presignUpload({
      workspaceId: wsId,
      uploaderId: user.id,
      name: body.name,
      mime: body.mime,
      sizeBytes: body.sizeBytes,
      filename: body.filename,
    });
  }

  @Post(':id/finalize')
  @Roles('ADMIN')
  @HttpCode(204)
  async finalize(
    @Param('wsId', new ParseUUIDPipe()) wsId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<void> {
    await this.svc.finalize(wsId, id, user.id);
  }

  /**
   * S41 (FR-EM04): 삭제는 업로드 본인 또는 OWNER/ADMIN. @Roles 를 떼어 멤버까지
   * 라우트를 통과시키고(WorkspaceRoleGuard 는 @Roles 미존재 시 no-op), 서비스에
   * caller 의 (id, role) 를 넘겨 분기한다 — 타인이 올린 이모지를 MEMBER 가 지우려
   * 하면 서비스가 403 으로 거부한다.
   */
  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Param('wsId', new ParseUUIDPipe()) wsId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: CurrentUserPayload,
    @CurrentMember() member: CurrentMemberPayload,
  ): Promise<void> {
    await this.rateLimit.enforce([{ key: `emoji:delete:${user.id}`, windowSec: 60, max: 30 }]);
    await this.svc.delete(wsId, id, user.id, member.role);
  }
}
