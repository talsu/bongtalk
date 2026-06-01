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

@Module({
  imports: [AuthModule, OutboxModule, PresenceModule],
  controllers: [
    WorkspacesController,
    MembersController,
    WorkspaceInvitesController,
    PublicInvitesController,
  ],
  providers: [WorkspacesService, MembersService, InvitesService],
  exports: [WorkspacesService, MembersService, InvitesService],
})
export class WorkspacesModule {}
