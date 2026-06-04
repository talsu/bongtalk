import { forwardRef, Module } from '@nestjs/common';
import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';
import { MembersController } from './members/members.controller';
import { MembersService } from './members/members.service';
import { InvitesService } from './invites/invites.service';
import { PublicInvitesController, WorkspaceInvitesController } from './invites/invites.controller';
// S68 (D13 / FR-W04·W04a·W18): 이메일 직접 초대 + 보류 초대 관리.
import { PendingInvitesService } from './pending-invites/pending-invites.service';
import {
  EmailInviteAcceptController,
  WorkspacePendingInvitesController,
} from './pending-invites/pending-invites.controller';
import { AuthModule } from '../auth/auth.module';
import { OutboxModule } from '../common/outbox/outbox.module';
// S27 (FR-P08/P12): 멤버 목록 REST 가 프레즌스를 bulkFor 단일 조회로 읽기 위해
// PresenceModule 만 import 한다(게이트웨이 그래프 미포함 → 순환 없음).
import { PresenceModule } from '../realtime/presence/presence.module';
// S61 (D12 / FR-RM01·04·15): 역할 관리 REST + 권한 상승 방어 + 삭제 cascade.
// RoleCacheQueueService 는 @Global QueueModule 이 제공하므로 import 불필요(주입만).
import { RolesController } from './roles/roles.controller';
import { RolesService } from './roles/roles.service';
import { MemberRoleService } from './roles/member-role.service';
// S63 (D12 / FR-RM05·06·07): 모더레이션(Kick/Ban/Timeout) REST + 도메인 서비스.
// AuditService 는 @Global AuditModule 제공, Redis 는 @Global RedisModule 제공.
import { ModerationController } from './moderation/moderation.controller';
import { ModerationService } from './moderation/moderation.service';
// S64 (D12 / FR-RM12): 감사 로그 조회 REST. AuditService 는 @Global AuditModule 제공.
import { AuditLogController } from './audit/audit-log.controller';
// S64 (D12 / FR-RM11): 신고 큐 서비스/컨트롤러. DELETE_MESSAGE 처리에 MessagesService 를
// 재사용하므로 MessagesModule 을 forwardRef 로 가져온다(MessagesModule 이 WorkspacesModule 을
// import 하는 순환을 forwardRef 양방향으로 끊는다).
import { MessagesModule } from '../messages/messages.module';
// S64 fix-forward (security A-1/A-2): 신고 처리 DELETE_MESSAGE 의 채널 DELETE_ANY_MESSAGE
// 권한 fold + private 채널 content 마스킹에 ChannelAccessService 가 필요하다.
// ChannelsModule ↔ WorkspacesModule 양방향 순환을 forwardRef 로 끊는다.
import { ChannelsModule } from '../channels/channels.module';
import { ModerationReportController } from './moderation/moderation-report.controller';
import { ModerationReportService } from './moderation/moderation-report.service';
// S70 (D13 / FR-W06·W06a): 가입 신청(APPLY 모드) REST + 도메인 서비스. 인터뷰 1:1 DM 생성에
// DirectMessagesService(ChannelsModule)를 forwardRef 로 주입한다.
import { ApplicationsController } from './applications/applications.controller';
import { ApplicationsService } from './applications/applications.service';

@Module({
  imports: [
    AuthModule,
    OutboxModule,
    PresenceModule,
    forwardRef(() => MessagesModule),
    forwardRef(() => ChannelsModule),
  ],
  controllers: [
    WorkspacesController,
    MembersController,
    WorkspaceInvitesController,
    PublicInvitesController,
    WorkspacePendingInvitesController,
    EmailInviteAcceptController,
    RolesController,
    ModerationController,
    AuditLogController,
    ModerationReportController,
    ApplicationsController,
  ],
  providers: [
    WorkspacesService,
    MembersService,
    InvitesService,
    PendingInvitesService,
    RolesService,
    MemberRoleService,
    ModerationService,
    ModerationReportService,
    ApplicationsService,
  ],
  exports: [
    WorkspacesService,
    MembersService,
    InvitesService,
    RolesService,
    MemberRoleService,
    ModerationService,
    ModerationReportService,
  ],
})
export class WorkspacesModule {}
