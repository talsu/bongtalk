import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import type { PushNotificationPayload } from '@qufox/shared-types';
import { PrismaService } from '../prisma/prisma.module';
import { isDndSuppressed } from '../notifications/dnd-gate';
import { isMuteActive, shouldNotifyMention, type MentionKind } from '../notifications/notif-level';
import { PushService } from './push.service';
import { PUSH_SEND_QUEUE, type PushSendJobData } from './push-queue.constants';

const PREVIEW_LEN = 150;

/**
 * S86 (D16 / FR-MN-15): push-send 발화 worker(BullMQ in-process · reminder.processor 선례).
 *
 * 잡은 멘션 도착 시 enqueue 되며(데스크톱 활성=60초 지연·비활성=즉시), 실행 시점에 아래를
 * 재평가한 뒤에만 web-push 를 보낸다(이중 게이트 — enqueue 전 1차 게이트는 fanout 단계,
 * 잡 실행 시 2차 게이트는 그 사이 변한 상태를 반영):
 *
 *   (1) notifMobile/notifDesktop 둘 다 OFF → skip(사용자가 모든 기기 알림을 끔).
 *   (2) DND 활성(presencePreference=dnd · dndUntil 미래 · dndSchedule 구간) → skip.
 *   (3) NotifLevel 3계층(채널/서버/글로벌) + 뮤트 재평가 → 알림 비대상이면 skip.
 *   (4) read-check: 그 사이 사용자가 이 채널의 해당 메시지(이상)를 읽었으면 skip
 *       (60초 지연 동안 읽으면 불필요한 푸시를 억제 — PRD).
 *   (5) 통과하면 PushService.sendToUser(유효 구독 전부에 전송·stale GC).
 *
 * 모든 게이트 입력은 잡 실행 시점에 DB 재조회한다(enqueue 시점 스냅샷이 아님). 행 부재는
 * 안전한 기본값(글로벌 MENTIONS·DND 없음)으로 흐른다. 전송 실패는 PushService 가 흡수한다.
 */
@Processor(PUSH_SEND_QUEUE)
export class PushProcessor extends WorkerHost {
  private readonly logger = new Logger(PushProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushService,
  ) {
    super();
  }

  async process(job: Job<PushSendJobData>): Promise<void> {
    const data = job.data;
    const now = new Date();

    // (1)~(3): 게이트 입력 일괄 재조회(잡 실행 시점 진실값).
    const [user, settings, serverPref, channelMute] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: data.userId },
        select: { presencePreference: true, dndSchedule: true, timezone: true },
      }),
      this.prisma.userSettings.findUnique({
        where: { userId: data.userId },
        select: {
          notifTrigger: true,
          dndUntil: true,
          dndSchedule: true,
          notifMobile: true,
          notifDesktop: true,
        },
      }),
      data.workspaceId
        ? this.prisma.serverNotificationPref.findFirst({
            where: { userId: data.userId, workspaceId: data.workspaceId },
            select: {
              level: true,
              isMuted: true,
              muteUntil: true,
              suppressEveryone: true,
            },
          })
        : Promise.resolve(null),
      this.prisma.userChannelMute.findFirst({
        where: { userId: data.userId, channelId: data.channelId },
        select: { level: true, mutedUntil: true, isMuted: true },
      }),
    ]);

    // 계정 삭제(cascade) 등으로 사용자가 사라졌으면 skip.
    if (!user) {
      this.logger.debug(`[push] skip (no user) user=${data.userId}`);
      return;
    }

    // S86 리뷰 fix-forward (security MEDIUM-2): 잡 실행 시점 채널 접근 재검증. 멘션 fanout
    // 은 발화 시점에 VIEW_CHANNEL 을 게이트했지만, 데스크톱 활성 사용자는 60초 지연되므로
    // 그 사이 워크스페이스에서 kick/ban/leave 된 사용자에게 메시지 프리뷰(snippet)가 전송될
    // 수 있다. 워크스페이스 채널이면 멤버십을 재확인해, 더는 멤버가 아니면 skip 한다(비공개
    // 채널 override 중도 제거 같은 더 좁은 엣지는 <60초 전 가시 메시지라 수용). DM 채널
    // (workspaceId=null)은 멤버십 개념이 다르므로 이 게이트를 건너뛴다(fanout 게이트에 의존).
    if (data.workspaceId) {
      const stillMember = await this.prisma.workspaceMember.findFirst({
        where: { userId: data.userId, workspaceId: data.workspaceId },
        select: { userId: true },
      });
      if (!stillMember) {
        this.logger.debug(
          `[push] skip (no longer ws member) user=${data.userId} ws=${data.workspaceId}`,
        );
        return;
      }
    }

    // (1) 모든 기기 알림 OFF → 전송 의미 없음. settings 행 부재는 기본 ON 으로 본다.
    const notifMobile = settings?.notifMobile ?? true;
    const notifDesktop = settings?.notifDesktop ?? true;
    if (!notifMobile && !notifDesktop) {
      this.logger.debug(`[push] skip (all notif channels off) user=${data.userId}`);
      return;
    }

    // (2) DND 재평가(presencePreference · dndUntil · dndSchedule). dndSchedule 은 UserSettings
    // 와 User 양쪽에 존재할 수 있어, UserSettings 의 것을 우선하고 없으면 User 의 것으로 폴백한다
    // (dnd-gate 가 single shape 를 받으므로 합성한다).
    const dndSuppressed = isDndSuppressed(
      {
        presencePreference: user.presencePreference,
        dndUntil: settings?.dndUntil ?? null,
        dndSchedule: (settings?.dndSchedule as never) ?? (user.dndSchedule as never) ?? null,
        timezone: user.timezone,
      },
      now,
    );
    if (dndSuppressed) {
      this.logger.debug(`[push] skip (dnd) user=${data.userId}`);
      return;
    }

    // (3) NotifLevel 3계층 + 뮤트 재평가(notif-level 순수 헬퍼 단일 출처).
    const kind: MentionKind = data.everyone || data.here ? 'broad' : 'direct';
    const notify = shouldNotifyMention(
      {
        channelLevel: channelMute?.level ?? null,
        serverLevel: serverPref?.level ?? null,
        globalLevel: settings?.notifTrigger ?? null,
        serverMuted: isMuteActive(serverPref?.isMuted ?? false, serverPref?.muteUntil ?? null, now),
        channelMuted: isMuteActive(
          channelMute?.isMuted ?? false,
          channelMute?.mutedUntil ?? null,
          now,
        ),
        suppressEveryone: serverPref?.suppressEveryone ?? false,
      },
      kind,
    );
    if (!notify) {
      this.logger.debug(`[push] skip (notif level/mute) user=${data.userId} ch=${data.channelId}`);
      return;
    }

    // (4) read-check: 사용자가 그 사이 이 메시지(이상)를 읽었으면 skip. UserChannelReadState
    // 의 (createdAt, id) 튜플 커서가 이 메시지 커서 이상이면 읽은 것으로 본다(unread.service
    // 와 동일 공식). 행 부재/커서 NULL 이면 미읽음(전송 진행).
    const alreadyRead = await this.isMessageRead(data.userId, data.channelId, data.messageId);
    if (alreadyRead) {
      this.logger.debug(`[push] skip (already read) user=${data.userId} msg=${data.messageId}`);
      return;
    }

    // (5) 전송. payload 는 SW 가 showNotification 으로 매핑한다.
    const payload = this.buildPayload(data);
    const sent = await this.push.sendToUser(data.userId, payload);
    this.logger.debug(`[push] sent=${sent} user=${data.userId} ch=${data.channelId}`);
  }

  /**
   * 해당 메시지가 사용자에게 이미 읽힘 상태인지 판정한다. lastReadMessageCreatedAt 가 NULL 이거나
   * 메시지가 없으면(삭제) false(전송 진행 또는 안전 측). 읽음 = 저장 커서 (createdAt,id) 튜플이
   * 이 메시지의 튜플 이상.
   */
  private async isMessageRead(
    userId: string,
    channelId: string,
    messageId: string,
  ): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ is_read: boolean }>>`
      SELECT COALESCE(
        (rs."lastReadMessageCreatedAt", rs."lastReadMessageId")
          >= (m."createdAt", m.id),
        false
      ) AS is_read
      FROM "Message" m
      LEFT JOIN "UserChannelReadState" rs
        ON rs."userId" = ${userId}::uuid
       AND rs."channelId" = ${channelId}::uuid
      WHERE m.id = ${messageId}::uuid
        AND m."channelId" = ${channelId}::uuid
    `;
    return rows[0]?.is_read === true;
  }

  private buildPayload(data: PushSendJobData): PushNotificationPayload {
    const who = data.actorName?.trim() || '누군가';
    const broad = data.everyone || data.here;
    const title = broad ? `${who}님이 멘션했습니다` : `${who}님이 회원님을 멘션했습니다`;
    const body = (data.snippet ?? '').slice(0, PREVIEW_LEN) || '새 멘션이 도착했습니다.';
    // 딥링크: 워크스페이스/채널 경로. 클라 라우팅과 정합(없으면 SW 가 루트로 폴백).
    const url = data.workspaceId
      ? `/w/${data.workspaceId}/c/${data.channelId}`
      : `/c/${data.channelId}`;
    return {
      title,
      body,
      url,
      tag: `mention:${data.channelId}`,
    };
  }
}
