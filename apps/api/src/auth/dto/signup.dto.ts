import { IsEmail, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class SignupDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(32)
  @Matches(/^[a-zA-Z0-9_.-]+$/, { message: 'username has invalid characters' })
  username!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;

  // task-016-C-2: closed-beta gate. When BETA_INVITE_REQUIRED=true
  // the BetaInviteRequiredGuard on the route rejects signups that
  // arrive without a valid code. The guard re-queries Invite to
  // confirm existence + not expired + not revoked — signup itself
  // does not consume the invite (workspace join still uses the
  // existing /invites/:code/accept flow post-signup).
  @IsOptional()
  @IsString()
  @MaxLength(64)
  inviteCode?: string;
}
