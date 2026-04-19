import { Module } from '@nestjs/common';
import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';
import { MembersController } from './members/members.controller';
import { MembersService } from './members/members.service';
import { InvitesService } from './invites/invites.service';
import {
  PublicInvitesController,
  WorkspaceInvitesController,
} from './invites/invites.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
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
