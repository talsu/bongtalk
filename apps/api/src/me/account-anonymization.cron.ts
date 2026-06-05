import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.module';
import { REDIS } from '../redis/redis.module';
import { S3Service } from '../storage/s3.service';
import { resolveSystemAnonUserId } from '../common/anon-user';
import { deactivatedKey } from './account-lifecycle.service';

/**
 * S77c (D14 / FR-PS-19): 30일 익명화 크론.
 *
 * `deactivatedAt < now-30d` 인 비활성 계정을 대상으로 영구 익명화한다:
 *   1. PII null화 — handle / displayName / fullName / pronouns / title / bio / timezone /
 *      customStatus(+emoji/expiresAt) / avatarKey / bannerKey / handleChangedAt. email/username 은
 *      UNIQUE 라 충돌 회피 placeholder(deleted-{userId}@deleted.qufox · deleted-{userId})로 교체한다.
 *   2. Message.authorId → 고정 SYSTEM_ANON(seed.ts 의 user:system-anon 재사용). MessageEditHistory
 *      는 authorId 컬럼이 없고(메시지 FK Cascade) 내용 스냅샷은 메시지에 종속이라 별도 익명화 불요.
 *   3. Attachment 파일 MinIO 영구삭제(storageKey + thumbnailKey) 후 uploaderId → SYSTEM_ANON.
 *      AttachmentUploadSession(미완료 세션)은 행 삭제.
 *   4. WorkspaceMemberProfile(워크스페이스별 닉네임/About/아바타 = 추가 PII) 행 삭제(아바타 MinIO 동반 삭제).
 *   5. RefreshToken(세션) 삭제 + Redis `deactivated:{userId}` / `search:recent:{userId}` 정리.
 *   6. isDeactivated 유지(true) + deactivatedAt 보존하되 PII 만 제거 — 계정 자체는 "익명화됨" 상태로 남는다.
 *
 * ★ 멱등: 이미 익명화된(handle/displayName 등이 null 이고 email 이 placeholder 인) row 를 재실행해도
 *   같은 결과로 수렴한다(updateMany 가 동일 값으로 덮어쓰며, MinIO delete 는 idempotent).
 * ★ 30일 미만 / 비활성 아닌 계정 절대 미접근 — WHERE `isDeactivated=true AND deactivatedAt < cutoff` 가
 *   유일한 대상 필터다(활성 계정·복구창 내 계정은 절대 매칭되지 않는다).
 * ★ LIMIT 500 배치(대량 대비) — 한 번에 최대 500명만 처리하고, 다음 주기에 이어 처리한다.
 */
@Injectable()
export class AccountAnonymizationCron {
  private readonly logger = new Logger(AccountAnonymizationCron.name);

  // FR-PS-19: 익명화 복구창(일). AccountLifecycleService.RECOVERY_WINDOW_DAYS 와 동일 값을 둔다(둘 다
  // 30일 — 비활성화 후 30일이 지나야 익명화 대상이 된다).
  static readonly RECOVERY_WINDOW_DAYS = 30;
  // 한 배치에서 처리할 최대 계정 수(대량 대비 페이지네이션).
  static readonly BATCH_LIMIT = 500;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: S3Service,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /**
   * `now` 기준 30일 복구창이 지난 비활성 계정을 최대 BATCH_LIMIT 명 익명화한다. 처리한 계정 수를
   * 반환한다. cron 핸들러와 단위/통합 테스트가 공유한다.
   */
  async anonymizeBatch(now: Date): Promise<{ processed: number }> {
    const cutoff = new Date(
      now.getTime() - AccountAnonymizationCron.RECOVERY_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );
    // ★ 유일한 대상 필터 — 비활성 + 복구창 경과. 활성/복구창 내 계정은 절대 매칭되지 않는다.
    const targets = await this.prisma.user.findMany({
      where: { isDeactivated: true, deactivatedAt: { lt: cutoff } },
      orderBy: { deactivatedAt: 'asc' },
      take: AccountAnonymizationCron.BATCH_LIMIT,
      select: { id: true },
    });
    if (targets.length === 0) return { processed: 0 };

    const anonId = resolveSystemAnonUserId();
    // FK 유효성 가드: SYSTEM_ANON 행이 없으면(시드 누락) 익명화를 중단한다(authorId 재배치가 FK 위반).
    const anonExists = await this.prisma.user.findUnique({
      where: { id: anonId },
      select: { id: true },
    });
    if (!anonExists) {
      this.logger.error(JSON.stringify({ event: 'account.anonymize.anon_user_missing', anonId }));
      return { processed: 0 };
    }

    let processed = 0;
    for (const { id: userId } of targets) {
      if (userId === anonId) continue; // SYSTEM_ANON 자체는 익명화하지 않는다(방어).
      try {
        await this.anonymizeOne(userId, anonId);
        processed += 1;
      } catch (err) {
        this.logger.error(
          JSON.stringify({ event: 'account.anonymize.failed', userId }),
          err as Error,
        );
      }
    }
    if (processed > 0) {
      this.logger.log(JSON.stringify({ event: 'account.anonymize.swept', processed }));
    }
    return { processed };
  }

  /**
   * 단일 계정 익명화. MinIO 삭제(네트워크)는 트랜잭션 밖에서 먼저 best-effort 로 수행하고, DB
   * 변형(PII null·authorId 재배치·세션 삭제)은 단일 트랜잭션으로 원자 적용한다.
   */
  private async anonymizeOne(userId: string, anonId: string): Promise<void> {
    // (a) 사용자가 업로드한 Attachment 의 MinIO 객체 영구삭제(storageKey + thumbnailKey).
    const attachments = await this.prisma.attachment.findMany({
      where: { uploaderId: userId },
      select: { id: true, storageKey: true, thumbnailKey: true },
    });
    for (const a of attachments) {
      await this.deleteObjectSafe(a.storageKey);
      if (a.thumbnailKey) await this.deleteObjectSafe(a.thumbnailKey);
    }
    // (b) 워크스페이스별 프로필 아바타(추가 PII) MinIO 삭제.
    const wsProfiles = await this.prisma.workspaceMemberProfile.findMany({
      where: { userId },
      select: { avatarKey: true },
    });
    for (const p of wsProfiles) {
      if (p.avatarKey) await this.deleteObjectSafe(p.avatarKey);
    }

    // (c) DB 변형 — 단일 트랜잭션. 멱등(동일 값으로 덮어씀).
    await this.prisma.$transaction(async (tx) => {
      await tx.message.updateMany({ where: { authorId: userId }, data: { authorId: anonId } });
      await tx.attachment.updateMany({
        where: { uploaderId: userId },
        data: { uploaderId: anonId },
      });
      await tx.attachmentUploadSession.deleteMany({ where: { uploaderId: userId } });
      await tx.workspaceMemberProfile.deleteMany({ where: { userId } });
      await tx.refreshToken.deleteMany({ where: { userId } });
      await tx.user.update({ where: { id: userId }, data: anonymizedUserData(userId) });
    });

    // (d) Redis 정리(블랙리스트 + 검색 이력) — best-effort.
    await this.redis.del(deactivatedKey(userId)).catch(() => undefined);
    await this.redis.del(`search:recent:${userId}`).catch(() => undefined);

    this.logger.log(JSON.stringify({ event: 'account.anonymized', userId }));
  }

  private async deleteObjectSafe(key: string): Promise<void> {
    try {
      await this.storage.deleteObject(key);
    } catch (err) {
      // MinIO 미준비/일시 오류는 익명화를 막지 않는다(DB PII 제거가 우선). 다음 주기 재실행에서 재시도.
      this.logger.warn(
        JSON.stringify({ event: 'account.anonymize.minio_delete_failed', key }),
        err as Error,
      );
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async runDaily(): Promise<void> {
    try {
      await this.anonymizeBatch(new Date());
    } catch (err) {
      this.logger.error('account anonymization sweep failed', err as Error);
    }
  }
}

/**
 * 익명화 후 User row 의 PII null화 + UNIQUE 충돌 회피 placeholder. 순수 함수(부작용 없음) — 단위
 * 테스트가 직접 검증한다. isDeactivated 는 true 로 유지하고(계정은 "익명화됨" 상태로 남음),
 * deactivatedAt 은 건드리지 않는다(멱등 재실행 시 cutoff 판정 동일).
 */
export function anonymizedUserData(userId: string): {
  email: string;
  username: string;
  handle: null;
  displayName: null;
  fullName: null;
  pronouns: null;
  title: null;
  bio: null;
  timezone: null;
  customStatus: null;
  customStatusEmoji: null;
  customStatusExpiresAt: null;
  avatarKey: null;
  bannerKey: null;
  handleChangedAt: null;
} {
  return {
    // UNIQUE(email/username/handle) 충돌 회피 — userId 로 결정론 placeholder(멱등).
    email: `deleted-${userId}@deleted.qufox`,
    username: `deleted-${userId}`,
    handle: null,
    displayName: null,
    fullName: null,
    pronouns: null,
    title: null,
    bio: null,
    timezone: null,
    customStatus: null,
    customStatusEmoji: null,
    customStatusExpiresAt: null,
    avatarKey: null,
    bannerKey: null,
    handleChangedAt: null,
  };
}
