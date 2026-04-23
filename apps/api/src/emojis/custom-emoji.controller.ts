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
import { RateLimitService } from '../auth/services/rate-limit.service';
import { CustomEmojiService } from './custom-emoji.service';
import { PresignEmojiUploadDto } from './dto/presign-emoji-upload.dto';

/**
 * task-037-D: workspace emoji pack REST surface.
 *
 * - Any member can GET /list + react with existing emoji. Picker opens
 *   are cached by React Query (10-min staleTime) so the unrated GET is
 *   not the hot path; if a future client bypasses the cache we'll
 *   revisit adding a bucket.
 * - Upload + delete are OWNER/ADMIN only, mirroring the channel admin
 *   gate used in 011. Upload is 10/min per (workspace, user); delete
 *   is 30/min per user — cheap ops, bulk cleanup stays practical.
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

  @Delete(':id')
  @Roles('ADMIN')
  @HttpCode(204)
  async remove(
    @Param('wsId', new ParseUUIDPipe()) wsId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<void> {
    await this.rateLimit.enforce([{ key: `emoji:delete:${user.id}`, windowSec: 60, max: 30 }]);
    await this.svc.delete(wsId, id);
  }
}
