import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  WsIconPresignInputSchema,
  WsIconFinalizeInputSchema,
  type WsIconPresignResult,
  type WsIconFinalizeResult,
} from '@qufox/shared-types';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { RateLimitService } from '../auth/services/rate-limit.service';
import { Roles } from './decorators/roles.decorator';
import { WorkspaceMemberGuard } from './guards/workspace-member.guard';
import { WorkspaceRoleGuard } from './guards/workspace-role.guard';
import { WorkspacesService } from './workspaces.service';

/**
 * 072 백로그 S-C (FR-W01): 워크스페이스 아이콘 업로드/리셋.
 *
 *   POST   /workspaces/:id/icon/presign  body: { contentType, sizeBytes } → presigned POST
 *   PUT    /workspaces/:id/icon          body: { key }                    → { iconUrl }
 *   DELETE /workspaces/:id/icon          → 204
 *
 * 권한: WorkspaceMemberGuard(멤버십) + WorkspaceRoleGuard + @Roles('ADMIN')(ADMIN 이상 =
 * OWNER/ADMIN). 이름/설명 PATCH 와 동일한 게이트다 — 아이콘은 코스메틱이라 ADMIN 도 편집
 * 가능하다(visibility/category/joinMode 의 OWNER 전용 게이트와는 다르다).
 *
 * presign 은 별도 rate-limit(5/min)을 둔다(파일 업로드 토큰 남용 방지). finalize/delete 는
 * 워크스페이스 일반 변경과 동일하게 ws-icon:u:{id} 10/min 을 공유한다. 전역/ws아바타
 * 업로드 패턴과 동일하다([[feedback_no_server_media_resize]] — 서버 리사이즈 없음).
 */
@UseGuards(WorkspaceMemberGuard, WorkspaceRoleGuard)
@Roles('ADMIN')
@Controller('workspaces/:id/icon')
export class WorkspaceIconController {
  constructor(
    private readonly workspaces: WorkspacesService,
    private readonly rate: RateLimitService,
  ) {}

  @Post('presign')
  async presign(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ): Promise<WsIconPresignResult> {
    await this.rate.enforce([{ key: `ws-icon-presign:u:${user.id}`, windowSec: 60, max: 5 }]);
    const parsed = WsIconPresignInputSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        'invalid ws icon presign body (contentType/sizeBytes)',
      );
    }
    return this.workspaces.presignIcon(id, parsed.data.contentType, parsed.data.sizeBytes);
  }

  @Put()
  async finalize(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ): Promise<WsIconFinalizeResult> {
    await this.rate.enforce([{ key: `ws-icon:u:${user.id}`, windowSec: 60, max: 10 }]);
    const parsed = WsIconFinalizeInputSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'invalid ws icon finalize body (key)');
    }
    return this.workspaces.finalizeIcon(id, parsed.data.key);
  }

  @Delete()
  @HttpCode(204)
  async remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<void> {
    await this.rate.enforce([{ key: `ws-icon:u:${user.id}`, windowSec: 60, max: 10 }]);
    await this.workspaces.deleteIcon(id);
  }
}
