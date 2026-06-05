import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  CustomActionType,
  ExecuteSlashCommandResponse,
  ExecuteSlashEphemeralResponse,
  ExecuteSlashGiphyPreviewResponse,
} from '@qufox/shared-types';
import { MESSAGE_MAX_LENGTH } from '@qufox/shared-types';
import { PrismaService } from '../prisma/prisma.module';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { MessagesService } from '../messages/messages.service';
import { PresenceService } from '../realtime/presence/presence.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { CustomStatusService } from '../me/custom-status.service';
import { ChannelsService } from '../channels/channels.service';
import { ChannelAccessService } from '../channels/permission/channel-access.service';
import { DirectMessagesService } from '../channels/direct-messages/direct-messages.service';
import { Permission } from '../auth/permissions';
import { WorkspaceMemberProfileService } from '../workspaces/member-profile/workspace-member-profile.service';
import { ModerationService } from '../workspaces/moderation/moderation.service';
import { MutesService } from '../notifications/mutes/mutes.service';
import { resolveMentionHandles } from '../messages/mentions/mention-extractor';
import { buildBuiltinCommands } from './builtin-commands';
import {
  formatReminderAt,
  parseDndDuration,
  parseStatusArgs,
  transformInChannel,
} from './slash-transforms';
import { parseReminder, REMINDER_SYNTAX_HINT } from './reminder-parse';
import { ReminderService } from './reminder.service';
import { GiphyProxyService } from './giphy-proxy.service';

// /topic 길이 상한 — REST 경로의 UpdateChannelRequestSchema.topic.max(1024)와 동일하게
// 맞춘다(channel.ts). 슬래시 경로가 이 검증을 우회하지 않도록 runTopic 에서 강제한다.
const CHANNEL_TOPIC_MAX = 1024;

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
    // S81a (FR-SC-08): 서버 액션 커맨드는 기존 도메인 서비스를 그대로 재사용한다.
    private readonly channels: ChannelsService,
    private readonly channelAccess: ChannelAccessService,
    private readonly directMessages: DirectMessagesService,
    private readonly memberProfile: WorkspaceMemberProfileService,
    private readonly moderation: ModerationService,
    private readonly mutes: MutesService,
    // S81b (FR-SC-07): /giphy 는 GIPHY Search API 서버 프록시를 통해 GIF 한 개를 받는다.
    private readonly giphy: GiphyProxyService,
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

    // command 해석 — 빌트인 카탈로그 조회(GIPHY env 게이트 적용).
    const builtins = buildBuiltinCommands((process.env.GIPHY_API_KEY ?? '').trim().length > 0);
    const def = builtins.find((c) => c.name === command);
    if (!def) {
      // S81c (FR-SC-10): 빌트인에 없으면 워크스페이스 커스텀 커맨드(enabled·workspaceId·name)를
      // 조회해 configurable action 으로 실행한다. DM(workspaceId=null)은 커스텀 스코프가 없다.
      return this.runCustom(args, command);
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
        // ── S81a (FR-SC-08): 서버 액션 커맨드(기존 도메인 서비스 재사용) ──────────
        case 'nick':
          return this.runNick(args);
        case 'topic':
          return this.runTopic(args);
        case 'mute':
          return this.runMute(args);
        case 'kick':
          return this.runKick(args);
        case 'invite':
          return this.runInvite(args);
        case 'msg':
          return this.runMsg(args, now);
        // ── S81b (FR-SC-07): /giphy → GIPHY 프록시 + 발신자 전용 GIF 프리뷰 ──────────
        case 'giphy':
          return this.runGiphy(args);
        default:
          // 그 외 INTERNAL_ACTION 미구현 — 방어적(현재 도달 불가).
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
    // S81c 리뷰 fix-forward(MED-1 authz): 컨트롤러 ChannelAccessGuard 는 READ 만 검증하므로,
    // READ-only 멤버가 /shrug·/me 등으로 채널에 글을 게시하는 우회 면이 있었다. 게시 전에
    // WRITE_MESSAGE 비트를 검사한다(없으면 발신자 전용 EPHEMERAL error · 채널 미게시).
    const denied = await this.assertCanWrite(args.channelId, args.userId);
    if (denied) return denied;
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
    args: { userId: string; channelId: string; text: string; idempotencyKey: string },
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
      // S80 reviewer H1 fix: execute 멱등키를 영속해 (userId, key) UNIQUE 로 동시/재시도
      //   중복 등록을 차단한다(Redis slash-idem 의 read-then-write race 2차 방어).
      idempotencyKey: args.idempotencyKey,
      now,
    });
    return {
      responseType: 'EPHEMERAL',
      // S80 reviewer M3 fix: raw ISO 대신 한국어 로캘 + KST 로 발화 시각을 보여준다.
      content: `${formatReminderAt(item.scheduledAt)} 에 알려드릴게요: "${item.message}"`,
    };
  }

  // ── S81a (FR-SC-08): 서버 액션 커맨드 핸들러 ─────────────────────────────────────

  /**
   * /nick [별명] → 워크스페이스 닉네임 변경(본인). WorkspaceMemberProfileService.updateProfile
   * 재사용. 인자 없으면 닉네임을 비운다(null → 전역 표시명으로 폴백). DM(워크스페이스 없음)은
   * 워크스페이스 스코프가 없어 EPHEMERAL error.
   */
  private async runNick(args: {
    userId: string;
    workspaceId: string | null;
    text: string;
  }): Promise<ExecuteSlashCommandResponse> {
    if (args.workspaceId === null) {
      return this.forbiddenEphemeral('이 커맨드는 워크스페이스 채널에서만 사용할 수 있습니다');
    }
    const nickname = (args.text ?? '').trim();
    try {
      // 빈 입력 → null(닉네임 해제). 비어 있지 않으면 그 값으로 설정.
      await this.memberProfile.updateProfile(args.workspaceId, args.userId, {
        nickname: nickname.length > 0 ? nickname : null,
      });
    } catch (err) {
      return this.domainErrorToEphemeral(err);
    }
    return {
      responseType: 'EPHEMERAL',
      content:
        nickname.length > 0 ? `닉네임을 "${nickname}" 으로 바꿨습니다` : '닉네임을 지웠습니다',
    };
  }

  /**
   * /topic [텍스트] → 채널 토픽 변경. MANAGE_CHANNEL 비트 필요. ChannelsService.update 재사용
   * (토픽이 실제로 바뀌면 내부에서 SYSTEM_CHANNEL_TOPIC_CHANGED 메시지를 자동 발행한다).
   * 인자 없으면 토픽을 비운다(null). DM(워크스페이스 없음)은 EPHEMERAL error.
   */
  private async runTopic(args: {
    userId: string;
    workspaceId: string | null;
    channelId: string;
    text: string;
  }): Promise<ExecuteSlashCommandResponse> {
    if (args.workspaceId === null) {
      return this.forbiddenEphemeral('이 커맨드는 워크스페이스 채널에서만 사용할 수 있습니다');
    }
    const channel = await this.loadChannelMeta(args.channelId, args.workspaceId);
    if (!channel) {
      return this.forbiddenEphemeral('채널을 찾을 수 없습니다');
    }
    const allowed = await this.channelAccess.hasPermission(
      channel,
      args.userId,
      Permission.MANAGE_CHANNEL,
    );
    if (!allowed) {
      return this.forbiddenEphemeral('이 채널의 토픽을 바꿀 권한이 없습니다');
    }
    const topic = (args.text ?? '').trim();
    // S81a review fix(security H-1/reviewer MED-1): execute text 상한(3967)이 REST 경로의
    // UpdateChannelRequestSchema.topic.max(1024) 보다 커서, 슬래시 경로가 채널 토픽 길이
    // 검증을 우회해 과대 토픽이 SYSTEM 메시지로 fan-out 되는 abuse 면이 있었다. REST 와 동일한
    // 1024 상한을 슬래시 경로에도 강제한다(초과 시 발신자 전용 EPHEMERAL error).
    if (topic.length > CHANNEL_TOPIC_MAX) {
      return {
        responseType: 'EPHEMERAL',
        content: `채널 토픽은 ${CHANNEL_TOPIC_MAX}자를 넘을 수 없습니다`,
        error: true,
      };
    }
    try {
      await this.channels.update(args.workspaceId, args.channelId, args.userId, {
        topic: topic.length > 0 ? topic : null,
      });
    } catch (err) {
      return this.domainErrorToEphemeral(err);
    }
    return {
      responseType: 'EPHEMERAL',
      content: topic.length > 0 ? `채널 토픽을 바꿨습니다: ${topic}` : '채널 토픽을 지웠습니다',
    };
  }

  /**
   * /mute → 현재 채널 음소거(본인). MutesService.setMute 재사용(영구 뮤트 — mutedUntil null).
   * 권한은 채널 접근 가드(컨트롤러)가 이미 보장하므로 추가 게이트 불필요.
   */
  private async runMute(args: {
    userId: string;
    channelId: string;
  }): Promise<ExecuteSlashCommandResponse> {
    await this.mutes.setMute({ userId: args.userId, channelId: args.channelId, mutedUntil: null });
    return { responseType: 'EPHEMERAL', content: '이 채널의 알림을 음소거했습니다' };
  }

  /**
   * /kick @사람 → 멤버 강퇴. ModerationService.kick 재사용(KICK_MEMBERS 비트 + 계층 방어를
   * 서비스 내부가 강제). 대상 토큰을 워크스페이스 멤버로 해석하지 못하면 EPHEMERAL error.
   * DM(워크스페이스 없음)은 EPHEMERAL error.
   */
  private async runKick(args: {
    userId: string;
    workspaceId: string | null;
    text: string;
  }): Promise<ExecuteSlashCommandResponse> {
    if (args.workspaceId === null) {
      return this.forbiddenEphemeral('이 커맨드는 워크스페이스 채널에서만 사용할 수 있습니다');
    }
    const targetId = await this.resolveSingleTarget(args.workspaceId, args.text);
    if (!targetId) {
      return this.targetNotFoundEphemeral();
    }
    try {
      await this.moderation.kick({
        workspaceId: args.workspaceId,
        actorId: args.userId,
        targetUserId: targetId,
      });
    } catch (err) {
      return this.domainErrorToEphemeral(err);
    }
    return { responseType: 'EPHEMERAL', content: '멤버를 내보냈습니다' };
  }

  /**
   * /invite @사람 → 채널에 멤버 추가. MANAGE_CHANNEL 비트 필요. 채널 멤버십은
   * ChannelPermissionOverride(USER principal)의 READ ALLOW 로 표현되므로(비공개 채널 가시성
   * 모델), ChannelsService.addChannelMemberOverride 로 MEMBER baseline 마스크를 부여한다.
   * DM(워크스페이스 없음)은 EPHEMERAL error.
   */
  private async runInvite(args: {
    userId: string;
    workspaceId: string | null;
    channelId: string;
    text: string;
  }): Promise<ExecuteSlashCommandResponse> {
    if (args.workspaceId === null) {
      return this.forbiddenEphemeral('이 커맨드는 워크스페이스 채널에서만 사용할 수 있습니다');
    }
    const channel = await this.loadChannelMeta(args.channelId, args.workspaceId);
    if (!channel) {
      return this.forbiddenEphemeral('채널을 찾을 수 없습니다');
    }
    const allowed = await this.channelAccess.hasPermission(
      channel,
      args.userId,
      Permission.MANAGE_CHANNEL,
    );
    if (!allowed) {
      return this.forbiddenEphemeral('이 채널에 멤버를 추가할 권한이 없습니다');
    }
    const targetId = await this.resolveSingleTarget(args.workspaceId, args.text);
    if (!targetId) {
      return this.targetNotFoundEphemeral();
    }
    try {
      // 채널 멤버십 부여 = USER override 에 READ(+ 일반 참여) ALLOW. MEMBER baseline 을
      // 그대로 부여해 공개/비공개 채널 모두에서 정상 참여하게 한다(DM override 마스크와 동일
      // 의미의 채널 참여 권한). denyMask 0.
      await this.channels.addChannelMemberOverride(
        args.workspaceId,
        args.channelId,
        targetId,
        CHANNEL_MEMBER_ALLOW_MASK,
        0,
        args.userId,
      );
    } catch (err) {
      return this.domainErrorToEphemeral(err);
    }
    return { responseType: 'EPHEMERAL', content: '멤버를 이 채널에 추가했습니다' };
  }

  /**
   * /msg @사람 [메시지] → 1:1 DM 을 열고(없으면 생성) 선택적으로 첫 메시지를 보낸다.
   * DirectMessagesService.createOrGetGlobal 재사용(친구/프라이버시 게이트 포함). 응답은
   * EPHEMERAL 확인 + navigate(dm 채널 id) — FE 가 그 DM 으로 이동한다. 본문이 있으면
   * MessagesService.send 로 DM 채널에 게시한다(workspaceId=null).
   */
  private async runMsg(
    args: {
      userId: string;
      workspaceId: string | null;
      text: string;
      idempotencyKey: string;
    },
    _now: Date,
  ): Promise<ExecuteSlashCommandResponse> {
    const { targetId, rest } = await this.resolveTargetAndRest(args.workspaceId, args.text);
    if (!targetId) {
      return this.targetNotFoundEphemeral();
    }
    let channelId: string;
    try {
      const dm = await this.directMessages.createOrGetGlobal(args.userId, targetId);
      channelId = dm.channelId;
    } catch (err) {
      return this.domainErrorToEphemeral(err);
    }
    const body = rest.trim();
    if (body.length > 0) {
      try {
        await this.messages.send({
          workspaceId: null,
          channelId,
          authorId: args.userId,
          content: body,
          idempotencyKey: args.idempotencyKey,
        });
      } catch (err) {
        return this.domainErrorToEphemeral(err);
      }
    }
    const response: ExecuteSlashEphemeralResponse = {
      responseType: 'EPHEMERAL',
      content: body.length > 0 ? '다이렉트 메시지를 보냈습니다' : '다이렉트 메시지를 열었습니다',
      navigate: { kind: 'dm', channelId, userId: targetId },
    };
    return response;
  }

  /**
   * S81b (FR-SC-07): /giphy [키워드] → GIPHY 프록시 검색 후 발신자 전용 GIF 프리뷰
   * (GIPHY_PREVIEW). 채널에 게시하지 않고(FE 가 Shuffle/Send/Cancel UI 를 띄움), Send 시
   * gifUrl 을 일반 메시지로 게시한다(별도 경로 — FE). 키워드가 없으면 EPHEMERAL 안내,
   * 결과가 없으면 EPHEMERAL "결과 없음", 키 미설정/GIPHY 오류(GIPHY_UNAVAILABLE)는 graceful
   * 하게 EPHEMERAL error 로 흡수한다(절대 500/크래시 금지 — env-gate inert prod 포함).
   */
  private async runGiphy(args: { text: string }): Promise<ExecuteSlashCommandResponse> {
    const keyword = (args.text ?? '').trim();
    if (keyword.length === 0) {
      return {
        responseType: 'EPHEMERAL',
        content: '검색할 키워드를 입력해 주세요. 예: `/giphy 고양이`',
        error: true,
      };
    }
    let result: Awaited<ReturnType<GiphyProxyService['search']>>;
    try {
      result = await this.giphy.search(keyword, 0);
    } catch (err) {
      // GIPHY_UNAVAILABLE(키 미설정/오류/형식 위반)는 발신자 전용 EPHEMERAL error 로 흡수한다.
      if (err instanceof DomainError && err.code === ErrorCode.GIPHY_UNAVAILABLE) {
        return {
          responseType: 'EPHEMERAL',
          content: 'GIPHY 를 사용할 수 없습니다. 잠시 후 다시 시도해 주세요',
          error: true,
        };
      }
      throw err;
    }
    if (result === null) {
      return {
        responseType: 'EPHEMERAL',
        content: `"${keyword}" 에 해당하는 GIF 를 찾지 못했습니다`,
        error: true,
      };
    }
    const preview: ExecuteSlashGiphyPreviewResponse = {
      responseType: 'GIPHY_PREVIEW',
      gifUrl: result.gifUrl,
      gifThumbUrl: result.gifThumbUrl,
      title: result.title,
      keyword,
      offset: 0,
    };
    return preview;
  }

  // ── S81c (FR-SC-09·10): 워크스페이스 커스텀 커맨드 실행 ───────────────────────────

  /**
   * 빌트인에 없는 커맨드를 워크스페이스 커스텀 SlashCommand 로 조회해 실행한다.
   *   - DM(workspaceId=null) 또는 미존재·disabled → SLASH_COMMAND_UNKNOWN(빌트인 부재와 동일).
   *   - actionType 별 분기(EPHEMERAL_TEXT / SEND_TEMPLATE / REDIRECT_CHANNEL).
   *   - actionType/actionParams 형식 위반은 발신자 전용 EPHEMERAL error 로 흡수한다(채널 미게시).
   * ★ 외부 호출 분기 없음(PRD·SSRF 회피) — 안전한 in-process 액션만 실행한다.
   */
  private async runCustom(
    args: {
      userId: string;
      workspaceId: string | null;
      channelId: string;
      text: string;
      idempotencyKey: string;
    },
    command: string,
  ): Promise<ExecuteSlashCommandResponse> {
    if (args.workspaceId === null) {
      throw new DomainError(
        ErrorCode.SLASH_COMMAND_UNKNOWN,
        `알 수 없는 커맨드입니다: /${command}`,
      );
    }
    // S81c 리뷰 fix-forward(perf #1/#2): @@unique([workspaceId, name]) 복합 키로 단일 행을
    // 정확 조회한다(findFirst 풀스캔 회피). 이 경로에서 workspaceId 는 위 가드로 non-null 보장.
    // enabled 는 WHERE 가 아니라 코드에서 체크해, disabled 행도 미존재와 동일하게 UNKNOWN 으로
    // 떨군다(자동완성 목록은 enabled 만 노출하므로 사용자 관점에선 동일).
    const row = await this.prisma.slashCommand.findUnique({
      where: { workspaceId_name: { workspaceId: args.workspaceId, name: command } },
      select: { actionType: true, actionParams: true, enabled: true },
    });
    if (!row || row.actionType === null || row.enabled !== true) {
      throw new DomainError(
        ErrorCode.SLASH_COMMAND_UNKNOWN,
        `알 수 없는 커맨드입니다: /${command}`,
      );
    }
    const params = (row.actionParams ?? {}) as Record<string, unknown>;
    const actionType = row.actionType as CustomActionType;
    switch (actionType) {
      case 'EPHEMERAL_TEXT':
        return this.runCustomEphemeralText(params);
      case 'SEND_TEMPLATE':
        return this.runCustomTemplate(args, params);
      case 'REDIRECT_CHANNEL':
        return this.runCustomRedirect(args, params);
      default:
        // enum 이 확장됐는데 핸들러가 누락된 경우의 방어(현재 도달 불가).
        return this.malformedActionEphemeral();
    }
  }

  /** EPHEMERAL_TEXT: actionParams.text 를 발신자 전용 EPHEMERAL 로 반환(고정 안내문). */
  private runCustomEphemeralText(params: Record<string, unknown>): ExecuteSlashCommandResponse {
    const text = typeof params.text === 'string' ? params.text : '';
    if (text.length === 0) return this.malformedActionEphemeral();
    return { responseType: 'EPHEMERAL', content: text };
  }

  /**
   * SEND_TEMPLATE: actionParams.template 의 `{args}` 자리에 사용자 인자(args.text)를 1회 치환해
   * 채널에 일반 메시지로 게시한다(IN_CHANNEL·기존 MessagesService.send 재사용·멱등키). 치환 후
   * 본문이 비거나 MESSAGE 상한(4000)을 넘으면 발신자 전용 EPHEMERAL error 로 거부한다(채널 미게시).
   * `{args}` 가 없으면 인자는 무시되고 템플릿 그대로 게시된다.
   */
  private async runCustomTemplate(
    args: {
      userId: string;
      workspaceId: string | null;
      channelId: string;
      text: string;
      idempotencyKey: string;
    },
    params: Record<string, unknown>,
  ): Promise<ExecuteSlashCommandResponse> {
    const template = typeof params.template === 'string' ? params.template : '';
    if (template.length === 0) return this.malformedActionEphemeral();
    const content = substituteTemplateArgs(template, args.text ?? '');
    if (content.length === 0) {
      return {
        responseType: 'EPHEMERAL',
        content: '보낼 내용이 비어 있습니다',
        error: true,
      };
    }
    if (content.length > MESSAGE_MAX_LENGTH) {
      return {
        responseType: 'EPHEMERAL',
        content: `메시지가 너무 깁니다(${MESSAGE_MAX_LENGTH}자 이내)`,
        error: true,
      };
    }
    // S81c 리뷰 fix-forward(MED-1 authz): SEND_TEMPLATE 도 채널에 메시지를 게시하므로 게시 전에
    // WRITE_MESSAGE 비트를 검사한다(READ-only 멤버 우회 차단 — runInChannel 과 동일 게이트).
    const denied = await this.assertCanWrite(args.channelId, args.userId);
    if (denied) return denied;
    try {
      const { message } = await this.messages.send({
        workspaceId: args.workspaceId,
        channelId: args.channelId,
        authorId: args.userId,
        content,
        idempotencyKey: args.idempotencyKey,
      });
      return { responseType: 'IN_CHANNEL', messageId: message.id };
    } catch (err) {
      return this.domainErrorToEphemeral(err);
    }
  }

  /**
   * REDIRECT_CHANNEL: actionParams.channelId 로 클라이언트 네비게이션. ★IDOR 방지 — 대상 채널이
   * 본 워크스페이스 소속이고 발신자가 접근(READ) 가능한 경우에만 navigate 를 싣는다. 접근 불가/
   * 미존재면 발신자 전용 EPHEMERAL error(존재 누출 없이 "이동할 수 없습니다").
   */
  private async runCustomRedirect(
    args: { userId: string; workspaceId: string | null },
    params: Record<string, unknown>,
  ): Promise<ExecuteSlashCommandResponse> {
    const channelId = typeof params.channelId === 'string' ? params.channelId : '';
    if (channelId.length === 0 || args.workspaceId === null) {
      return this.malformedActionEphemeral();
    }
    const channel = await this.loadChannelMeta(channelId, args.workspaceId);
    if (!channel) {
      return {
        responseType: 'EPHEMERAL',
        content: '이동할 채널을 찾을 수 없습니다',
        error: true,
      };
    }
    const allowed = await this.channelAccess.hasPermission(channel, args.userId, Permission.READ);
    if (!allowed) {
      return {
        responseType: 'EPHEMERAL',
        content: '이 채널에 접근할 권한이 없습니다',
        error: true,
      };
    }
    // S81c 리뷰 fix-forward(MAJOR-1): canonical 라우트(`/w/:slug/:channelName`)를 구성할 수 있도록
    // slug + channelName 을 싣는다. 워크스페이스 slug 가 없는 비정상 행(이론상 도달 불가 — 위에서
    // workspaceId 일치 + 채널 로드 성공)은 안전하게 형식 위반으로 흡수한다(존재 누출 없이 미게시).
    const slug = channel.workspace?.slug;
    if (!slug) {
      return this.malformedActionEphemeral();
    }
    return {
      responseType: 'EPHEMERAL',
      content: '채널로 이동합니다',
      navigate: { kind: 'channel', channelId, slug, channelName: channel.name },
    };
  }

  private malformedActionEphemeral(): ExecuteSlashCommandResponse {
    return {
      responseType: 'EPHEMERAL',
      content: '이 커맨드의 설정이 올바르지 않습니다. 워크스페이스 관리자에게 문의해 주세요',
      error: true,
    };
  }

  // ── S81a (FR-SC-08): 공유 헬퍼 ──────────────────────────────────────────────────

  /**
   * S81c 리뷰 fix-forward(MED-1 authz): IN_CHANNEL 게시(/shrug·/me·SEND_TEMPLATE) 직전의
   * WRITE_MESSAGE 게이트. channelId 는 컨트롤러 ChannelAccessGuard 가 READ 검증한 URL 경로
   * 식별자라 신뢰 가능하므로, 워크스페이스 일치 제약 없이 id 로 ACL 메타(workspaceId/isPrivate)를
   * 로드한다(DM 채널도 동일 경로 — DM 멤버는 override 로 WRITE 보유). soft-delete 행은 제외한다.
   *
   * 반환값: 권한이 없으면(또는 채널 미존재) 발신자 전용 EPHEMERAL error 응답을, 게시 허용이면
   * null 을 돌려준다(호출부는 null 이면 send 로 진행).
   *
   * ★ANNOUNCEMENT 채널 게이트·slowmode 는 이번 OUT(carryover) — WRITE_MESSAGE 비트만 검사한다.
   */
  private async assertCanWrite(
    channelId: string,
    userId: string,
  ): Promise<ExecuteSlashCommandResponse | null> {
    const channel = await this.prisma.channel.findFirst({
      where: { id: channelId, deletedAt: null },
      select: { id: true, workspaceId: true, isPrivate: true },
    });
    if (!channel) {
      return { responseType: 'EPHEMERAL', content: '채널을 찾을 수 없습니다', error: true };
    }
    const allowed = await this.channelAccess.hasPermission(
      channel,
      userId,
      Permission.WRITE_MESSAGE,
    );
    if (!allowed) {
      return {
        responseType: 'EPHEMERAL',
        content: '이 채널에 글을 쓸 권한이 없습니다',
        error: true,
      };
    }
    return null;
  }

  /**
   * 채널 ACL 검사에 필요한 메타를 로드한다. soft-delete 제외. id/workspaceId/isPrivate 외에,
   * REDIRECT_CHANNEL navigate 가 canonical 라우트(`/w/:slug/:channelName`)를 구성하도록 채널
   * name 과 워크스페이스 slug 를 함께 싣는다(추가 컬럼은 다른 호출부에 무해 — ACL 검사만 쓰면 무시).
   */
  private async loadChannelMeta(
    channelId: string,
    workspaceId: string,
  ): Promise<{
    id: string;
    workspaceId: string | null;
    isPrivate: boolean;
    name: string;
    workspace: { slug: string } | null;
  } | null> {
    const ch = await this.prisma.channel.findFirst({
      where: { id: channelId, workspaceId, deletedAt: null },
      select: {
        id: true,
        workspaceId: true,
        isPrivate: true,
        name: true,
        workspace: { select: { slug: true } },
      },
    });
    return ch;
  }

  /**
   * text 에서 첫 `@username` 토큰을 워크스페이스 멤버 userId 로 해석한다. 기존 멘션 resolver
   * (resolveMentionHandles — 워크스페이스 멤버 스코프)를 재사용한다. 해석 결과가 정확히
   * 하나가 아니면(0개 또는 미해결) null. 본인 자신은 대상에서 제외하지 않는다(호출부 도메인
   * 서비스가 self 금지를 자체 강제 — 예: moderation.kick → MODERATION_CANNOT_SELF).
   */
  private async resolveSingleTarget(workspaceId: string, text: string): Promise<string | null> {
    const map = await resolveMentionHandles(this.prisma, workspaceId, text ?? '');
    const ids = [...new Set(map.values())];
    return ids.length === 1 ? ids[0] : null;
  }

  /**
   * /msg 용 — 첫 @username 대상 해석 + 그 토큰 이후의 본문을 분리한다. text 가 `@alice 안녕`
   * 이면 { targetId, rest:'안녕' }. 대상 토큰을 텍스트에서 제거해 본문에 핸들이 남지 않게 한다.
   * 해석 실패 시 targetId=null.
   */
  private async resolveTargetAndRest(
    workspaceId: string | null,
    text: string,
  ): Promise<{ targetId: string | null; rest: string }> {
    const raw = text ?? '';
    // DM 개시는 전역(친구) 스코프지만, @핸들 해석은 워크스페이스 멤버 네임스페이스에 의존한다.
    // 슬래시는 워크스페이스 채널에서 트리거되므로 그 워크스페이스로 핸들을 해석한다.
    if (workspaceId === null) {
      return { targetId: null, rest: raw };
    }
    const match = raw.match(/@([A-Za-z0-9_.-]{2,32})/);
    if (!match) {
      return { targetId: null, rest: raw };
    }
    const map = await resolveMentionHandles(this.prisma, workspaceId, raw);
    const targetId = map.get(match[1].toLowerCase()) ?? null;
    // 매칭된 핸들 토큰을 본문에서 한 번 제거한다(첫 매치 기준).
    const rest = raw.replace(match[0], '').replace(/\s+/g, ' ').trim();
    return { targetId, rest };
  }

  private forbiddenEphemeral(content: string): ExecuteSlashCommandResponse {
    return { responseType: 'EPHEMERAL', content, error: true };
  }

  private targetNotFoundEphemeral(): ExecuteSlashCommandResponse {
    return {
      responseType: 'EPHEMERAL',
      content: '대상을 찾을 수 없습니다. @사용자명 형태로 지정해 주세요',
      error: true,
    };
  }

  /**
   * 도메인 서비스가 던진 DomainError 를 발신자 전용 EPHEMERAL error 로 변환한다(채널 미게시).
   * 도메인 에러가 아니면 그대로 rethrow 해 상위 예외 필터가 처리하게 둔다(예상치 못한 오류).
   */
  private domainErrorToEphemeral(err: unknown): ExecuteSlashCommandResponse {
    if (err instanceof DomainError) {
      return { responseType: 'EPHEMERAL', content: err.message, error: true };
    }
    throw err;
  }

  private async userWorkspaceIds(userId: string): Promise<string[]> {
    const memberships = await this.prisma.workspaceMember.findMany({
      where: { userId, workspace: { deletedAt: null } },
      select: { workspaceId: true },
    });
    return memberships.map((m) => m.workspaceId);
  }
}

/**
 * S81a (FR-SC-08): /invite 가 부여하는 채널 멤버십 권한 마스크. DM 멤버십(READ|WRITE|
 * DELETE_OWN|UPLOAD)과 동일한 일반 참여 비트 — 비공개 채널 가시성 게이트는 READ ALLOW 로
 * 열리고, 공개 채널에서는 baseline 위 무해한 중복이다(이미 가진 비트 재부여).
 */
const CHANNEL_MEMBER_ALLOW_MASK =
  Permission.READ |
  Permission.WRITE_MESSAGE |
  Permission.DELETE_OWN_MESSAGE |
  Permission.UPLOAD_ATTACHMENT;

/**
 * S81c (FR-SC-10): SEND_TEMPLATE 치환 — 템플릿의 `{args}` 토큰(전부)을 사용자 인자로 1회 치환한다.
 *
 * 안전성:
 *   - 치환은 단순 문자열 replace 다. 사용자 인자는 그대로 메시지 본문이 되고(채널 게시), mrkdwn
 *     렌더링/이스케이프는 메시지 표시 파이프라인(클라)이 일반 메시지와 동일하게 처리한다 — 즉
 *     이 경로가 만드는 본문은 사용자가 직접 친 메시지와 동일한 신뢰 수준이다(권한 상승 없음).
 *   - 정규식 특수문자(`$1` 등 replacement 패턴)가 인자에 들어가도 영향받지 않도록 replacer 함수
 *     형태로 치환한다(String.prototype.replace 의 `$` 치환 패턴 우회).
 *   - 길이 상한(MESSAGE_MAX_LENGTH)은 호출부가 치환 결과에 강제한다(여기선 미강제).
 * 인자가 비어 있으면 `{args}` 는 빈 문자열로 치환된다(템플릿 그대로 유지가 아니라 토큰 제거).
 */
export function substituteTemplateArgs(template: string, rawArgs: string): string {
  const replacement = rawArgs.trim();
  return template.replace(/\{args\}/g, () => replacement).trim();
}
