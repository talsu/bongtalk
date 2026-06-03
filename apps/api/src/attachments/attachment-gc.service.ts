import { Injectable, Logger } from '@nestjs/common';
import { AttachmentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';
import { S3Service } from '../storage/s3.service';
import {
  isMagicChecked,
  matchesMagic,
  MAGIC_PREFIX_BYTES,
  type MagicSupportedMime,
} from '../storage/validate-magic-bytes';
import {
  ATTACHMENT_GC_BATCH_SIZE,
  ATTACHMENT_GC_UNLINKED_GRACE_HOURS,
} from '../queue/attachment-gc.constants';

/**
 * S55 (D11 / FR-AM-29) — 첨부 orphan GC 도메인 서비스(BullMQ 분리).
 *
 * 프로세서(AttachmentGcProcessor)는 이 서비스의 `sweep()` 만 호출한다. 큐 인프라와
 * 분리해 int/unit 테스트가 BullMQ 실타이머 없이 직접 호출할 수 있게 한다(reminder
 * 큐의 processor↔service 분리 패턴과 일관).
 *
 * orphan 정의:
 *   (A) Attachment 중 `messageId IS NULL OR (linkedAt IS NULL AND createdAt < now-24h)`.
 *       - messageId NULL: 어떤 메시지에도 안 붙은 첨부. complete(targetChannelId) pre-link
 *         후 끝내 메시지에 안 실렸거나, finalize 단계 이전에 버려진 행.
 *       - linkedAt NULL 24h+: 연결되지 않은 채 24시간 경과(pre-link 유예 만료).
 *   (B) 만료 미완료 세션(AttachmentUploadSession: completed=false AND expiresAt < now).
 *
 * 처리:
 *   - 각 orphan Attachment: magic-byte 재검증(getObjectRange 8192B) → 불일치면
 *     processingStatus=BLOCKED 마킹(감사 로그) 후 객체+행 삭제, 일치하면 그냥 삭제.
 *   - MinIO deleteObject(idempotent) + DB 행 삭제. 한 행 실패가 배치 전체를 중단하지
 *     않도록 try/catch 로 격리한다(실패 격리·멱등).
 *   - 배치 pagination(BATCH_SIZE)으로 대량 orphan 을 끊어 처리한다.
 *
 * `now` 는 주입(테스트 결정성). 반환 카운터로 발화 로그/메트릭을 남긴다.
 */
@Injectable()
export class AttachmentGcService {
  private readonly logger = new Logger(AttachmentGcService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
  ) {}

  /**
   * orphan Attachment + 만료 세션을 한 번 sweep 한다. 멱등(이미 삭제된 행은 다음 배치
   * 셀렉터에 안 잡힘) + 실패 격리(행별 try/catch). 반환은 처리 카운터.
   */
  async sweep(now: Date = new Date()): Promise<{
    attachmentsDeleted: number;
    attachmentsBlocked: number;
    sessionsDeleted: number;
    failures: number;
  }> {
    let attachmentsDeleted = 0;
    let attachmentsBlocked = 0;
    let sessionsDeleted = 0;
    let failures = 0;

    const graceCutoff = new Date(
      now.getTime() - ATTACHMENT_GC_UNLINKED_GRACE_HOURS * 60 * 60 * 1000,
    );

    // ── (A) orphan Attachment 배치 처리 ───────────────────────────────────────
    // 매 배치마다 같은 셀렉터로 take(BATCH) — 삭제로 줄어드는 모집단을 반복 소진한다.
    // BLOCKED 마킹된 행은 messageId NULL 조건에 여전히 잡힐 수 있어 무한 루프를 막기
    // 위해, BLOCKED 도 객체+행을 함께 삭제한다(아래). 따라서 매 배치 모집단은 단조
    // 감소한다.
    // eslint-disable-next-line no-constant-condition
    for (;;) {
      const orphans = await this.prisma.attachment.findMany({
        where: {
          // S55 리뷰 BLOCKER(GC-1): 종전 `{ messageId: null }` 단독 절은 grace 가 없어
          // 방금 complete(targetChannelId) 한 pre-link 첨부(messageId=null·linkedAt=null·
          // createdAt=now)를 메시지 전송 전에 즉시 삭제(데이터 파괴)했다. complete(messageId)
          // 와 messages.send 는 messageId·linkedAt 을 함께 stamp 하므로 `linkedAt IS NULL`
          // 이 곧 "아직 전송 메시지에 연결 안 됨" 신호다 — 24h grace 를 둔 단일 조건으로 통합.
          linkedAt: null,
          createdAt: { lt: graceCutoff },
        },
        select: { id: true, storageKey: true, mime: true, storedMimeType: true },
        orderBy: { createdAt: 'asc' },
        take: ATTACHMENT_GC_BATCH_SIZE,
      });
      if (orphans.length === 0) break;
      const deletedBefore = attachmentsDeleted;

      for (const orphan of orphans) {
        try {
          // magic-byte 재검증 — declared MIME(또는 확정된 storedMimeType)이 검사 대상이면
          // 실 바이트 prefix 와 교차검증한다. 불일치면 BLOCKED 마킹(감사) 후 삭제.
          const mimeLower = (orphan.storedMimeType ?? orphan.mime).toLowerCase();
          if (isMagicChecked(mimeLower)) {
            const prefix = await this.s3.getObjectRange(orphan.storageKey, MAGIC_PREFIX_BYTES - 1);
            const ok = prefix !== null && matchesMagic(prefix, mimeLower as MagicSupportedMime);
            if (!ok) {
              // 감사: 마킹을 먼저 영속화(삭제 전 BLOCKED 상태가 잠시라도 관측되도록)한 뒤
              // 객체+행을 삭제한다. 마킹 자체가 감사 로그 트레일이다.
              await this.prisma.attachment.update({
                where: { id: orphan.id },
                data: { processingStatus: AttachmentStatus.BLOCKED },
              });
              attachmentsBlocked += 1;
              this.logger.warn(
                `[attachment-gc] BLOCKED orphan id=${orphan.id} key=${orphan.storageKey} declared=${mimeLower} (magic mismatch on GC re-check)`,
              );
            }
          }
          // MinIO deleteObject(idempotent) + DB 행 삭제. 객체 먼저, 그다음 행.
          await this.s3.deleteObject(orphan.storageKey);
          await this.prisma.attachment.delete({ where: { id: orphan.id } });
          attachmentsDeleted += 1;
        } catch (err) {
          failures += 1;
          this.logger.warn(
            `[attachment-gc] orphan delete failed id=${orphan.id} key=${orphan.storageKey} err=${String(err).slice(0, 160)}`,
          );
        }
      }
      // 마지막 페이지(BATCH 미만)면 종료. 가득 찼으면 다음 배치를 더 돈다. 단, 가득 찬
      // 배치에서 한 건도 삭제하지 못했다면(전부 S3/DB 실패) 동일 페이지가 무한 반복되므로
      // 진행 없음으로 보고 중단한다(실패 행은 다음 일일 sweep 에서 재시도).
      if (orphans.length < ATTACHMENT_GC_BATCH_SIZE) break;
      if (attachmentsDeleted === deletedBefore) {
        this.logger.warn(
          '[attachment-gc] full batch made no progress (all failed) — stopping sweep',
        );
        break;
      }
    }

    // ── (B) 만료 미완료 세션 정리 ─────────────────────────────────────────────
    // eslint-disable-next-line no-constant-condition
    for (;;) {
      const sessions = await this.prisma.attachmentUploadSession.findMany({
        where: { completed: false, expiresAt: { lt: now } },
        select: { id: true, storageKey: true },
        orderBy: { expiresAt: 'asc' },
        take: ATTACHMENT_GC_BATCH_SIZE,
      });
      if (sessions.length === 0) break;
      const sessDeletedBefore = sessionsDeleted;

      for (const session of sessions) {
        try {
          // 세션은 업로드가 landed 했을 수도(orphan 객체) 안 했을 수도 있다 — 어느
          // 쪽이든 deleteObject 는 idempotent(미존재 키는 no-op)다.
          await this.s3.deleteObject(session.storageKey);
          await this.prisma.attachmentUploadSession.delete({ where: { id: session.id } });
          sessionsDeleted += 1;
        } catch (err) {
          failures += 1;
          this.logger.warn(
            `[attachment-gc] expired session delete failed id=${session.id} err=${String(err).slice(0, 160)}`,
          );
        }
      }
      if (sessions.length < ATTACHMENT_GC_BATCH_SIZE) break;
      if (sessionsDeleted === sessDeletedBefore) {
        this.logger.warn(
          '[attachment-gc] full session batch made no progress (all failed) — stopping sweep',
        );
        break;
      }
    }

    this.logger.log(
      `[attachment-gc] sweep done deleted=${attachmentsDeleted} blocked=${attachmentsBlocked} sessions=${sessionsDeleted} failures=${failures}`,
    );
    return { attachmentsDeleted, attachmentsBlocked, sessionsDeleted, failures };
  }
}
