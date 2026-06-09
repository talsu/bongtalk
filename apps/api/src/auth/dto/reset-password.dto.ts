import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * AUTH-3 (PRD D18 §5 / FR-AUTH-41): POST /auth/reset-password 요청 DTO. token + 새 비밀번호.
 * shared-types ResetPasswordRequestSchema 와 동일 계약(token, password=PasswordSchema min(8)).
 * 비밀번호 정책(min 8 · max 128)은 SignupDto 와 동일하게 class-validator 로 선검증한다.
 */
export class ResetPasswordDto {
  @IsString()
  @MinLength(1)
  token!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;
}
