import { Module } from '@nestjs/common';
import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';
import { MembersController } from './members/members.controller';
import { MembersService } from './members/members.service';
import { InvitesService } from './invites/invites.service';
import { PublicInvitesController, WorkspaceInvitesController } from './invites/invites.controller';
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

@Module({
  imports: [AuthModule, OutboxModule, PresenceModule],
  controllers: [
    WorkspacesController,
    MembersController,
    WorkspaceInvitesController,
    PublicInvitesController,
    RolesController,
    ModerationController,
  ],
  providers: [
    WorkspacesService,
    MembersService,
    InvitesService,
    RolesService,
    MemberRoleService,
    ModerationService,
  ],
  exports: [
    WorkspacesService,
    MembersService,
    InvitesService,
    RolesService,
    MemberRoleService,
    ModerationService,
  ],
})
export class WorkspacesModule {}
