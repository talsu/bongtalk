import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { MoveFavoriteRequest } from '@qufox/shared-types';
import { PrismaService } from '../../prisma/prisma.module';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';
import { calcBetween } from '../positioning/fractional-position';

/**
 * S43 (FR-CH-15): 채널 즐겨찾기 서비스.
 *
 * 정책:
 *  - 즐겨찾기는 개인 상태다 — (userId, channelId) 가 유니크하며 각자 자기
 *    목록만 본다.
 *  - 추가는 멱등(upsert) — 이미 즐겨찾기면 같은 행을 반환하고 position 은
 *    유지한다(중복 추가가 순서를 흩뜨리지 않는다).
 *  - 신규 추가 position 은 사용자 목록 말단 + STRIDE(calcBetween(last, null)).
 *  - 재정렬은 채널 move 와 동일한 fractional anchor 규약(beforeId/afterId)을
 *    쓰고 동일 calcBetween 을 재사용한다. anchor 가 모두 없으면 말단으로 간주.
 *  - 호출 컨트롤러가 ChannelAccessGuard(VIEW_CHANNEL)로 채널 접근을 선검증한다 —
 *    이 서비스 자체는 권한을 보지 않는다(뮤트 서비스와 동일 분리).
 */

export type FavoriteRow = {
  channelId: string;
  position: Prisma.Decimal;
  createdAt: Date;
};

@Injectable()
export class FavoritesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 즐겨찾기 추가(멱등). 이미 존재하면 기존 행을 그대로 반환한다(position 보존).
   * 신규는 사용자 목록 말단 position 으로 만든다.
   */
  async addFavorite(userId: string, channelId: string): Promise<FavoriteRow> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.userChannelFavorite.findUnique({
        where: { userId_channelId: { userId, channelId } },
        select: { channelId: true, position: true, createdAt: true },
      });
      if (existing) return existing;

      const last = await tx.userChannelFavorite.findFirst({
        where: { userId },
        orderBy: { position: 'desc' },
        select: { position: true },
      });
      const position = calcBetween(last?.position ?? null, null);
      const row = await tx.userChannelFavorite.create({
        data: { userId, channelId, position },
        select: { channelId: true, position: true, createdAt: true },
      });
      return row;
    });
  }

  /** 즐겨찾기 해제 — 행 삭제. 미존재면 idempotent. */
  async removeFavorite(userId: string, channelId: string): Promise<void> {
    await this.prisma.userChannelFavorite.deleteMany({
      where: { userId, channelId },
    });
  }

  /** 사용자의 즐겨찾기 전체. position 오름차순(사이드바 렌더 순서). */
  async listFavorites(userId: string): Promise<FavoriteRow[]> {
    return this.prisma.userChannelFavorite.findMany({
      where: { userId },
      orderBy: { position: 'asc' },
      select: { channelId: true, position: true, createdAt: true },
    });
  }

  /**
   * 즐겨찾기 재정렬. 채널 move 와 동일하게 beforeId/afterId 가 목표 위치를
   * 고정하고, 둘 다 없으면 말단으로 간주한다. anchor 는 같은 사용자의 다른
   * 즐겨찾기 채널 id 여야 한다. calcBetween 이 인접 차를 소진하면(1e-10 미만)
   * CHANNEL_POSITION_INVALID 를 던져 클라가 재정규화 경로를 트리거하게 한다
   * (채널 reorder 와 동일 임계). 단일 트랜잭션으로 anchor 조회 + update 를 묶는다.
   */
  async moveFavorite(
    userId: string,
    channelId: string,
    input: MoveFavoriteRequest,
  ): Promise<FavoriteRow> {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.userChannelFavorite.findUnique({
        where: { userId_channelId: { userId, channelId } },
        select: { id: true },
      });
      if (!current) {
        throw new DomainError(ErrorCode.FAVORITE_NOT_FOUND, 'favorite not found');
      }

      const [after, before] = await Promise.all([
        input.afterId
          ? tx.userChannelFavorite.findUnique({
              where: { userId_channelId: { userId, channelId: input.afterId } },
              select: { position: true },
            })
          : Promise.resolve(null),
        input.beforeId
          ? tx.userChannelFavorite.findUnique({
              where: { userId_channelId: { userId, channelId: input.beforeId } },
              select: { position: true },
            })
          : Promise.resolve(null),
      ]);

      let prev = after?.position ?? null;
      let next = before?.position ?? null;
      if (!after && !before) {
        const last = await tx.userChannelFavorite.findFirst({
          where: { userId, NOT: { channelId } },
          orderBy: { position: 'desc' },
          select: { position: true },
        });
        prev = last?.position ?? null;
        next = null;
      }

      const position = calcBetween(prev, next);
      const row = await tx.userChannelFavorite.update({
        where: { userId_channelId: { userId, channelId } },
        data: { position },
        select: { channelId: true, position: true, createdAt: true },
      });
      return row;
    });
  }
}
