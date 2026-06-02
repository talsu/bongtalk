import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { MoveFavoriteRequestSchema } from '@qufox/shared-types';
import { FavoritesService } from './favorites.service';
import { ChannelAccessGuard } from '../guards/channel-access.guard';
import { WorkspaceMemberGuard } from '../../workspaces/guards/workspace-member.guard';
import { CurrentUser, CurrentUserPayload } from '../../auth/decorators/current-user.decorator';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';

/**
 * S43 (FR-CH-15): 채널 즐겨찾기 endpoints (워크스페이스 스코프).
 *
 * 권한 모델: 즐겨찾기 대상은 워크스페이스 멤버(WorkspaceMemberGuard)이고
 * 채널이 VIEW 가능해야(ChannelAccessGuard — VIEW_CHANNEL = READ 비트) 한다.
 * 즐겨찾기 자체는 개인 상태라 ADMIN 권한을 요구하지 않는다 — 멤버가 본인
 * 사이드바를 정리하는 동작이다. 가드가 채널을 req.channel 에 적재하고
 * 비공개 채널 비가시 시 CHANNEL_NOT_VISIBLE 를 던진다(정보 누출 방지).
 *
 * 라우트는 `workspaces/:id/channels/:chid/favorite` — ChannelAccessGuard 가
 * :chid 를 채널 id, :id 를 워크스페이스 id 로 해석한다(채널 컨트롤러 동일 패턴).
 */
@UseGuards(WorkspaceMemberGuard, ChannelAccessGuard)
@Controller('workspaces/:id/channels/:chid/favorite')
export class FavoritesController {
  constructor(private readonly favorites: FavoritesService) {}

  @Post()
  @HttpCode(200)
  async add(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @Param('chid', new ParseUUIDPipe()) channelId: string,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    const row = await this.favorites.addFavorite(user.id, channelId);
    return shapeFavorite(row);
  }

  @Delete()
  @HttpCode(204)
  async remove(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @Param('chid', new ParseUUIDPipe()) channelId: string,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    await this.favorites.removeFavorite(user.id, channelId);
  }

  @Patch('position')
  @HttpCode(200)
  async move(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @Param('chid', new ParseUUIDPipe()) channelId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ) {
    const parsed = MoveFavoriteRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    const row = await this.favorites.moveFavorite(user.id, channelId, parsed.data);
    return shapeFavorite(row);
  }
}

/**
 * S43 (FR-CH-15): 전체 즐겨찾기 목록 (개인 스코프, 워크스페이스 무관).
 * 사이드바 Favorites 섹션이 현재 워크스페이스 채널 id 와 교집합해 렌더한다 —
 * 다른 워크스페이스 채널 즐겨찾기는 클라가 무시한다(여기서는 전체 반환).
 */
@Controller('me/favorites')
export class MeFavoritesController {
  constructor(private readonly favorites: FavoritesService) {}

  @Get()
  async list(@CurrentUser() user: CurrentUserPayload) {
    const rows = await this.favorites.listFavorites(user.id);
    return { items: rows.map(shapeFavorite) };
  }
}

function shapeFavorite(row: {
  channelId: string;
  position: { toString: () => string };
  createdAt: Date;
}) {
  return {
    channelId: row.channelId,
    position: row.position.toString(),
    createdAt: row.createdAt.toISOString(),
  };
}
