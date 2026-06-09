import { IsEmail } from 'class-validator';

/**
 * AUTH-3 (PRD D18 §5 / FR-AUTH-40): POST /auth/forgot-password 요청 DTO. 이메일만 받는다.
 * shared-types ForgotPasswordRequestSchema 와 동일 계약(email). 계정 존재 여부와 무관하게
 * 컨트롤러가 항상 200 을 반환한다(열거 방어).
 */
export class ForgotPasswordDto {
  @IsEmail()
  email!: string;
}
