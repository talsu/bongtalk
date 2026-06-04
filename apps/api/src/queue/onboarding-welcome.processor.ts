import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { Prisma } from '@prisma/client';
import { renderSystemMessageTemplate } from '@qufox/shared-types';
import { PrismaService } from '../prisma/prisma.module';
import { OutboxService } from '../common/outbox/outbox.service';
import { processMrkdwn } from '../messages/mrkdwn-pipeline';
import { MESSAGE_CREATED } from '../messages/events/message-events';
import { DM_CREATED } from '../channels/events/channel-events';
import { Permission } from '../auth/permissions';
import {
  ONBOARDING_WELCOME_QUEUE,
  type OnboardingWelcomeJobData,
} from './onboarding-welcome.constants';

// DM USER override allowMask(READ|WRITE|DELETE_OWN|UPLOAD) — direct-messages.service 와 동일 값.
const DM_ALLOW_MASK_BIGINT = BigInt(
  Permission.READ |
    Permission.WRITE_MESSAGE |
    Permission.DELETE_OWN_MESSAGE |
    Permission.UPLOAD_ATTACHMENT,
);

const EMPTY_MENTIONS = {
  users: [],
  channels: [],
  everyone: false,
  here: false,
  channel: false,
} as const;

/**
 * S71 (D13 / FR-W09): 워크스페이스 웰컴 발송 worker(BullMQ in-process).
 *
 * 관심사(Step2) 완료 트랜잭션 커밋 후 enqueue 된 잡을 처리한다(시스템 DM·입장 메시지를
 * tx 와 분리). 절차(모두 best-effort · 멱등):
 *   (1) WorkspaceWelcome 행 조회. 부재면 skip(Step3 비대상). 멤버십 부재(강퇴/탈퇴)면 skip.
 *   (2) welcome.message 가 있으면 워크스페이스 owner ↔ 신규 멤버 1:1 DM 을 createOrGet
 *       (멱등)한 뒤 owner 작성 DEFAULT 메시지로 웰컴 본문을 게시한다.
 *   (3) welcome.welcomeChannelId 가 있으면 그 채널에 SYSTEM_MEMBER_JOINED 입장 메시지를
 *       게시한다(createSystemMessage 와 동일 행 형태 — authorType=SYSTEM).
 *
 * MessagesModule/ChannelsModule 을 import 하지 않고 PrismaService + OutboxService(@Global)
 * 만으로 메시지를 직접 삽입한다 — QueueModule 이 무거운 도메인 모듈을 끌어들이지 않게 하기
 * 위함이다(temp-evict processor 선례 + createSystemMessage/createInterviewDm 행 형태 복제).
 */
@Processor(ONBOARDING_WELCOME_QUEUE, { concurrency: 4 })
export class OnboardingWelcomeProcessor extends WorkerHost {
  private readonly logger = new Logger(OnboardingWelcomeProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {
    super();
  }

  async process(job: Job<OnboardingWelcomeJobData>): Promise<void> {
    const { workspaceId, userId } = job.data;

    const welcome = await this.prisma.workspaceWelcome.findUnique({
      where: { workspaceId },
      select: { welcomeChannelId: true, message: true },
    });
    if (!welcome) {
      this.logger.debug(`[welcome] skip (no welcome config) ws=${workspaceId}`);
      return;
    }

    // 멤버십 + owner 확인. 멤버가 떠났으면(강퇴/탈퇴) skip.
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { ownerId: true },
    });
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { userId: true },
    });
    if (!ws || !member) {
      this.logger.debug(`[welcome] skip (ws/member gone) ws=${workspaceId} user=${userId}`);
      return;
    }

    // (2) 웰컴 메시지 DM — owner 가 신규 멤버에게 보낸다(owner == member 인 생성자 자신이면 skip).
    if (welcome.message && welcome.message.trim().length > 0 && ws.ownerId !== userId) {
      try {
        const channelId = await this.ensureWelcomeDm(workspaceId, ws.ownerId, userId);
        await this.postDefaultMessage(channelId, ws.ownerId, welcome.message);
      } catch (err) {
        this.logger.warn(
          `[welcome] DM post failed ws=${workspaceId} user=${userId}: ${String(err).slice(0, 160)}`,
        );
      }
    }

    // (3) welcomeChannel 입장 시스템 메시지.
    if (welcome.welcomeChannelId) {
      try {
        await this.postChannelJoinSystemMessage(workspaceId, welcome.welcomeChannelId, userId);
      } catch (err) {
        this.logger.warn(
          `[welcome] channel join message failed ws=${workspaceId} ch=${welcome.welcomeChannelId}: ${String(err).slice(0, 160)}`,
        );
      }
    }

    this.logger.log(`[welcome] delivered ws=${workspaceId} user=${userId}`);
  }

  /** workspace-scoped 1:1 DM(owner ↔ member) createOrGet. createInterviewDm 의 행 형태 복제. */
  private async ensureWelcomeDm(
    workspaceId: string,
    ownerId: string,
    memberId: string,
  ): Promise<string> {
    const name = this.dmChannelName(ownerId, memberId);
    const existing = await this.prisma.channel.findFirst({
      where: { workspaceId, name, type: 'DIRECT', deletedAt: null },
      select: { id: true },
    });
    if (existing) return existing.id;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const ch = await tx.channel.create({
          data: { workspaceId, name, type: 'DIRECT', isPrivate: true, topic: null, position: 0 },
        });
        for (const uid of [ownerId, memberId]) {
          await tx.channelPermissionOverride.create({
            data: {
              channelId: ch.id,
              principalType: 'USER',
              principalId: uid,
              allowMask: DM_ALLOW_MASK_BIGINT,
              denyMask: 0n,
              visibleFrom: new Date(),
            },
          });
        }
        await this.outbox.record(tx, {
          aggregateType: 'channel',
          aggregateId: ch.id,
          eventType: DM_CREATED,
          payload: { channelId: ch.id, participantIds: [ownerId, memberId], isGroup: false },
        });
        return ch.id;
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        const winner = await this.prisma.channel.findFirst({
          where: { workspaceId, name, type: 'DIRECT', deletedAt: null },
          select: { id: true },
        });
        if (winner) return winner.id;
      }
      throw err;
    }
  }

  /** dm: prefix 정렬-안정 채널명(direct-messages.service.channelName 규약과 동일). */
  private dmChannelName(a: string, b: string): string {
    const [x, y] = [a, b].sort();
    return `dm:${x}:${y}`;
  }

  /** owner 작성 DEFAULT 메시지를 DM 에 게시 + MESSAGE_CREATED outbox. */
  private async postDefaultMessage(
    channelId: string,
    authorId: string,
    content: string,
  ): Promise<void> {
    const processed = processMrkdwn(content);
    await this.prisma.$transaction(async (tx) => {
      const created = await tx.message.create({
        data: {
          channelId,
          authorId,
          authorType: 'USER',
          type: 'DEFAULT',
          content,
          contentPlain: processed.contentPlain,
          contentRaw: content,
          contentAst: processed.contentAst as unknown as Prisma.InputJsonValue,
          contentPlainV2: processed.contentPlain,
          mentions: EMPTY_MENTIONS as unknown as Prisma.InputJsonValue,
        },
      });
      await this.outbox.record(tx, {
        aggregateType: 'Message',
        aggregateId: created.id,
        eventType: MESSAGE_CREATED,
        payload: {
          // DM 채널은 workspaceId=null 로 라우팅(채널 룸 기준 fanout — MessageCreatedPayload 규약).
          workspaceId: null,
          channelId,
          actorId: authorId,
          nonce: null,
          message: {
            id: created.id,
            authorId: created.authorId,
            content: created.content,
            contentRaw: created.contentRaw ?? created.content,
            contentAst: processed.contentAst,
            contentPlain: processed.contentPlain,
            type: 'DEFAULT',
            mentions: EMPTY_MENTIONS,
            createdAt: created.createdAt.toISOString(),
            parentMessageId: created.parentMessageId,
          },
        },
      });
    });
  }

  /** welcomeChannel 에 SYSTEM_MEMBER_JOINED 입장 메시지 게시 + MESSAGE_CREATED outbox. */
  private async postChannelJoinSystemMessage(
    workspaceId: string,
    channelId: string,
    userId: string,
  ): Promise<void> {
    // 입장 시스템 메시지는 채널이 살아있고 워크스페이스 소속일 때만 게시한다.
    const channel = await this.prisma.channel.findFirst({
      where: { id: channelId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!channel) return;
    const actor = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { username: true },
    });
    const contentRaw = renderSystemMessageTemplate('SYSTEM_MEMBER_JOINED', {
      username: actor?.username ?? '',
    });
    const processed = processMrkdwn(contentRaw);
    await this.prisma.$transaction(async (tx) => {
      const created = await tx.message.create({
        data: {
          channelId,
          authorId: userId,
          authorType: 'SYSTEM',
          type: 'SYSTEM_MEMBER_JOINED',
          content: contentRaw,
          contentPlain: processed.contentPlain,
          contentRaw,
          contentAst: processed.contentAst as unknown as Prisma.InputJsonValue,
          contentPlainV2: processed.contentPlain,
          mentions: EMPTY_MENTIONS as unknown as Prisma.InputJsonValue,
        },
      });
      await this.outbox.record(tx, {
        aggregateType: 'Message',
        aggregateId: created.id,
        eventType: MESSAGE_CREATED,
        payload: {
          workspaceId,
          channelId,
          actorId: userId,
          nonce: null,
          message: {
            id: created.id,
            authorId: created.authorId,
            content: created.content,
            contentRaw: created.contentRaw ?? created.content,
            contentAst: processed.contentAst,
            contentPlain: processed.contentPlain,
            type: 'SYSTEM_MEMBER_JOINED',
            mentions: EMPTY_MENTIONS,
            createdAt: created.createdAt.toISOString(),
            parentMessageId: created.parentMessageId,
          },
        },
      });
    });
  }
}
