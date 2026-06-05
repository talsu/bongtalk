import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ExecuteSlashCommandResponse } from '@qufox/shared-types';
import { PrismaService } from '../prisma/prisma.module';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { MessagesService } from '../messages/messages.service';
import { PresenceService } from '../realtime/presence/presence.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { CustomStatusService } from '../me/custom-status.service';
import { buildBuiltinCommands } from './builtin-commands';
import { parseDndDuration, parseStatusArgs, transformInChannel } from './slash-transforms';
import { parseReminder, REMINDER_SYNTAX_HINT } from './reminder-parse';
import { ReminderService } from './reminder.service';

/**
 * S80 (D15 / FR-SC-04·05·06) — 슬래시 커맨드 *실행* 도메인 서비스 (Fork2 = A 단일 진입점).
 *
 * 컨트롤러는 멱등·rate·가드만 처리하고, command 해석~핸들러 분기~서비스 호출은 전부 이
 * 서비스의 단일 execute() 진입점이 수행한다(클라이언트/WS 어느 트리거든 동일 경로).
 *
 * 라우팅:
 *   - command → BUILTIN_COMMANDS 조회(없으면 SLASH_COMMAND_UNKNOWN). 커스텀 실행은 S81 OUT
 *     (handlerType 만으론 실행기를 모르므로 SLASH_COMMAND_NOT_EXECUTABLE).
 *   - IN_CHANNEL(BUILTIN: shrug/tableflip/unflip/me) → 텍스트 변환 후 MessagesService.send
 *     로 채널 게시 → { responseType:'IN_CHANNEL', messageId }.
 *   - INTERNAL_ACTION(away/active/dnd/status/remind) → presence/status/reminder 서비스 →
 *     EPHEMERAL 확인(발신자 전용·채널 미게시).
 *   - 미구현 빌트인(giphy·nick — S81+) → SLASH_COMMAND_NOT_EXECUTABLE.
 */
@Injectable()
export class SlashExecutionService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly messages: MessagesService,
    private readonly presence: PresenceService,
    private readonly gateway: RealtimeGateway,
    private readonly status: CustomStatusService,
    private readonly reminders: ReminderService,
  ) {}

  async execute(args: {
    userId: string;
    workspaceId: string | null;
    channelId: string;
    command: string;
    text: string;
    idempotencyKey: string;
    now?: Date;
  }): Promise<ExecuteSlashCommandResponse> {
    const now = args.now ?? new Date();
    const command = args.command.replace(/^\//, '').trim().toLowerCase();

    // command 해석 — 빌트인 카탈로그 조회(GIPHY env 게이트 적용). 커스텀은 S81 OUT.
    const builtins = buildBuiltinCommands((process.env.GIPHY_API_KEY ?? '').trim().length > 0);
    const def = builtins.find((c) => c.name === command);
    if (!def) {
      throw new DomainError(ErrorCode.SLASH_COMMAND_UNKNOWN, `알 수 없는 커맨드입니다: /${command}`);
    }

    // IN_CHANNEL 빌트인(텍스트 변환 → 메시지 전송 경로 재사용).
    if (def.responseType === 'IN_CHANNEL' && def.handlerType === 'BUILTIN') {
      return this.runInChannel(args, command, now);
    }

    // INTERNAL_ACTION(EPHEMERAL) 빌트인.
    if (def.handlerType === 'INTERNAL_ACTION') {
      switch (command) {
        case 'away':
          return this.setPresence(args.userId, 'auto', '상태를 자리 비움(자동)으로 바꿨습니다');
        case 'active':
          return this.setPresence(args.userId, 'auto', '상태를 온라인으로 바꿨습니다');
        case 'dnd':
          return this.runDnd(args.userId, args.text, now);
        case 'status':
          return this.runStatus(args.userId, args.text, now);
        case 'remind':
          return this.runRemind(args, now);
        default:
          // giphy·nick 등 — 실행기 미구현(S81+ OUT).
          throw new DomainError(
            ErrorCode.SLASH_COMMAND_NOT_EXECUTABLE,
            `이 커맨드는 아직 실행을 지원하지 않습니다: /${command}`,
          );
      }
    }

    // shortcuts/darkmode 등 클라이언트 전용 BUILTIN(EPHEMERAL) — 서버 실행 없음(S82+ OUT).
    throw new DomainError(
      ErrorCode.SLASH_COMMAND_NOT_EXECUTABLE,
      `이 커맨드는 아직 실행을 지원하지 않습니다: /${command}`,
    );
  }

  /** IN_CHANNEL: 텍스트 변환 후 MessagesService.send 재사용 → 채널 게시. */
  private async runInChannel(
    args: {
      userId: string;
      workspaceId: string | null;
      channelId: string;
      text: string;
      idempotencyKey: string;
    },
    command: string,
    _now: Date,
  ): Promise<ExecuteSlashCommandResponse> {
    const content = transformInChannel(command, args.text ?? '');
    if (content === null) {
      return {
        responseType: 'EPHEMERAL',
        content: `/${command} 에 표시할 메시지를 입력해 주세요`,
        error: true,
      };
    }
    const { message } = await this.messages.send({
      workspaceId: args.workspaceId,
      channelId: args.channelId,
      authorId: args.userId,
      content,
      // 멱등성: execute 컨트롤러가 Redis slash-idem 으로 1차 dedup 하고, send 의
      // (authorId, idempotencyKey) UNIQUE 가 2차 방어선이다(동일 키 재전송 → 같은 행).
      idempotencyKey: args.idempotencyKey,
    });
    return { responseType: 'IN_CHANNEL', messageId: message.id };
  }

  /** /away·/active → presence preference 전환(me-presence.controller 패턴 재사용). */
  private async setPresence(
    userId: string,
    preference: 'auto' | 'dnd' | 'invisible',
    confirm: string,
  ): Promise<ExecuteSlashCommandResponse> {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        presencePreference: preference,
        dndScheduleSnapshot: Prisma.JsonNull,
        ...(preference === 'dnd' ? { lastSeenAt: new Date() } : {}),
      },
    });
    const workspaceIds = await this.userWorkspaceIds(userId);
    await this.presence.setPreferenceForUser(userId, workspaceIds, preference);
    for (const wsId of workspaceIds) this.gateway.schedulePresenceBroadcastPublic(wsId);
    void this.gateway.fanOutPresenceUpdatePublic(userId).catch(() => undefined);
    return { responseType: 'EPHEMERAL', content: confirm };
  }

  /** /dnd [30m|1h|2h|tonight] → DND 전환. 기간은 확인 메시지에 표기(자동 해제는 DEFER). */
  private async runDnd(
    userId: string,
    text: string,
    now: Date,
  ): Promise<ExecuteSlashCommandResponse> {
    const dur = parseDndDuration(text ?? '', now);
    if (dur.kind === 'invalid') {
      return {
        responseType: 'EPHEMERAL',
        content: '기간을 이해하지 못했습니다. 예: `/dnd 30m` · `/dnd 1h` · `/dnd tonight`',
        error: true,
      };
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        presencePreference: 'dnd',
        dndScheduleSnapshot: Prisma.JsonNull,
        lastSeenAt: new Date(),
      },
    });
    const workspaceIds = await this.userWorkspaceIds(userId);
    await this.presence.setPreferenceForUser(userId, workspaceIds, 'dnd');
    for (const wsId of workspaceIds) this.gateway.schedulePresenceBroadcastPublic(wsId);
    void this.gateway.fanOutPresenceUpdatePublic(userId).catch(() => undefined);
    const content =
      dur.kind === 'until'
        ? `방해 금지 모드를 켰습니다 (${dur.until.toISOString()} 까지 — 수동 해제 전까지 유지)`
        : '방해 금지 모드를 켰습니다';
    return { responseType: 'EPHEMERAL', content };
  }

  /** /status :이모지: [텍스트] → CustomStatusService.set 재사용. */
  private async runStatus(
    userId: string,
    text: string,
    now: Date,
  ): Promise<ExecuteSlashCommandResponse> {
    const { emoji, text: statusText } = parseStatusArgs(text ?? '');
    await this.status.set(userId, { emoji, text: statusText }, now);
    const content =
      emoji || statusText
        ? `상태를 설정했습니다: ${[emoji, statusText].filter(Boolean).join(' ')}`
        : '상태를 지웠습니다';
    return { responseType: 'EPHEMERAL', content };
  }

  /** /remind <자연어 시각> <메시지> → 파싱 + Reminder 저장 + BullMQ 잡. */
  private async runRemind(
    args: { userId: string; channelId: string; text: string },
    now: Date,
  ): Promise<ExecuteSlashCommandResponse> {
    const parsed = parseReminder(args.text ?? '', now);
    if (!parsed.ok) {
      return {
        responseType: 'EPHEMERAL',
        content: `시각을 이해하지 못했습니다. ${REMINDER_SYNTAX_HINT}`,
        error: true,
      };
    }
    const item = await this.reminders.persist({
      userId: args.userId,
      channelId: args.channelId,
      message: parsed.message,
      scheduledAt: parsed.scheduledAt,
      now,
    });
    return {
      responseType: 'EPHEMERAL',
      content: `${item.scheduledAt} 에 알려드릴게요: "${item.message}"`,
    };
  }

  private async userWorkspaceIds(userId: string): Promise<string[]> {
    const memberships = await this.prisma.workspaceMember.findMany({
      where: { userId, workspace: { deletedAt: null } },
      select: { workspaceId: true },
    });
    return memberships.map((m) => m.workspaceId);
  }
}
