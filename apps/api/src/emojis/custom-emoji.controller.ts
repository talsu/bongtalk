import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
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
import { EmojiPreferenceService } from './emoji-preference.service';
import { PresignEmojiUploadDto } from './dto/presign-emoji-upload.dto';
import { AddAliasDto } from './dto/add-alias.dto';
import { UpdateWorkspaceEmojiConfigDto } from './dto/update-workspace-emoji-config.dto';

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

  /**
   * S42 (FR-PK04): presign 은 더 이상 @Roles('ADMIN') 하드게이트가 아니다 — 멤버까지
   * 라우트를 통과시키고, 서비스가 (role∈{OWNER,ADMIN}) OR canMemberUpload 로 분기한다.
   * WorkspaceEmojiConfig 행이 없거나 canMemberUpload=false 면 MEMBER 는 403(현행 보존).
   */
  @Post('presign-upload')
  async presign(
    @Param('wsId', new ParseUUIDPipe()) wsId: string,
    @CurrentUser() user: CurrentUserPayload,
    @CurrentMember() member: CurrentMemberPayload,
    @Body() body: PresignEmojiUploadDto,
  ) {
    await this.rateLimit.enforce([
      { key: `emoji:upload:${wsId}:${user.id}`, windowSec: 60, max: 10 },
    ]);
    return this.svc.presignUpload({
      workspaceId: wsId,
      uploaderId: user.id,
      uploaderRole: member.role,
      name: body.name,
      mime: body.mime,
      sizeBytes: body.sizeBytes,
      filename: body.filename,
    });
  }

  /**
   * S42 fix-forward (BLOCKER): finalize 도 presign 과 동일하게 멤버까지 라우트를
   * 통과시키되(@Roles 없음), 서비스가 (role∈{OWNER,ADMIN}) OR canMemberUpload 로
   * 게이트한다. presign 만 막고 finalize 를 열어두면 canMemberUpload=false 워크스페이스
   * 에서 권한 비대칭으로 업로드를 확정해버릴 우회 경로가 생기므로, caller role 을
   * @CurrentMember() 로 받아 서비스 finalize 초입의 assertCanUpload 에 넘긴다.
   */
  @Post(':id/finalize')
  @HttpCode(204)
  async finalize(
    @Param('wsId', new ParseUUIDPipe()) wsId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: CurrentUserPayload,
    @CurrentMember() member: CurrentMemberPayload,
  ): Promise<void> {
    await this.svc.finalize(wsId, id, user.id, member.role);
  }

  /**
   * S42 (FR-EM05): 별칭 추가. OWNER/ADMIN 전용(@Roles('ADMIN')). alias 형식·이모지당
   * 10개 한도·워크스페이스 내 unique(name 충돌 포함)는 서비스가 검사한다. 201 +
   * { aliases: string[] }(변경 후 전체 별칭 스냅샷).
   */
  @Post(':id/aliases')
  @Roles('ADMIN')
  async addAlias(
    @Param('wsId', new ParseUUIDPipe()) wsId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: AddAliasDto,
  ) {
    await this.rateLimit.enforce([
      { key: `emoji:alias:${wsId}:${user.id}`, windowSec: 60, max: 30 },
    ]);
    return this.svc.addAlias(wsId, id, body.alias, user.id);
  }

  /**
   * S42 (FR-EM05): 별칭 삭제. 생성자 또는 OWNER/ADMIN(아니면 403). @Roles 없이 멤버까지
   * 통과시키고 서비스가 (callerId, role) 로 분기한다. 204.
   */
  @Delete(':id/aliases/:alias')
  @HttpCode(204)
  async removeAlias(
    @Param('wsId', new ParseUUIDPipe()) wsId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('alias') alias: string,
    @CurrentUser() user: CurrentUserPayload,
    @CurrentMember() member: CurrentMemberPayload,
  ): Promise<void> {
    await this.rateLimit.enforce([
      { key: `emoji:alias:${wsId}:${user.id}`, windowSec: 60, max: 30 },
    ]);
    await this.svc.removeAlias(wsId, id, alias, user.id, member.role);
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

/**
 * S42 (FR-PK01 / FR-PK04): 워크스페이스 이모지 설정/피커 데이터. emojis 컨트롤러와
 * 동일 가드 체인을 쓰되 prefix 가 `workspaces/:wsId`(emojis 하위가 아님)라 별도
 * 컨트롤러로 분리한다(Nest 는 `..` 상대 경로를 해석하지 않음).
 */
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, WorkspaceRoleGuard)
@Controller('workspaces/:wsId')
export class WorkspaceEmojiSettingsController {
  constructor(private readonly prefs: EmojiPreferenceService) {}

  /**
   * FR-PK01: 피커 초기 데이터. WorkspaceMember 면 누구나 — @Roles 없음. GET 멱등
   * (행 없으면 기본값 채워 반환, upsert 안 함).
   */
  @Get('emoji-picker-data')
  async pickerData(
    @Param('wsId', new ParseUUIDPipe()) wsId: string,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.prefs.getPickerData(wsId, user.id);
  }

  /**
   * FR-PK04: 워크스페이스 이모지 설정 변경. OWNER/ADMIN 전용. quickReactions
   * (≤3·각 ≤64자) / canMemberUpload(boolean) upsert. 200 + 전체 행.
   */
  @Patch('emoji-config')
  @Roles('ADMIN')
  async updateConfig(
    @Param('wsId', new ParseUUIDPipe()) wsId: string,
    @Body() body: UpdateWorkspaceEmojiConfigDto,
  ) {
    return this.prefs.updateWorkspaceConfig(wsId, {
      quickReactions: body.quickReactions,
      canMemberUpload: body.canMemberUpload,
    });
  }
}
