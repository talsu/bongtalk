import { z } from 'zod';

export const PasswordSchema = z
  .string()
  .min(8, 'password must be at least 8 characters')
  .max(128, 'password too long');

export const SignupRequestSchema = z.object({
  email: z.string().email(),
  username: z
    .string()
    .min(2)
    .max(32)
    .regex(/^[a-zA-Z0-9_.-]+$/, 'username has invalid characters'),
  password: PasswordSchema,
});
export type SignupRequest = z.infer<typeof SignupRequestSchema>;

export const LoginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(128),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const AuthUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  username: z.string().min(2).max(32),
  createdAt: z.string().datetime(),
  // S66 (D13 / FR-W05b): signup/login 응답에 emailVerified 를 실어 클라이언트가 가입
  // 직후·로그인 시 인증 대기 화면으로 분기한다(가입 직후는 항상 false).
  emailVerified: z.boolean(),
});
export type AuthUser = z.infer<typeof AuthUserSchema>;

// S66 (D13 / FR-W05a/W05b): GET /auth/me 응답. 이메일 인증 게이트(FR-W05b)가
// emailVerified=false 를 감지해 인증 대기 화면(.qf-verify-email-gate)을 렌더한다.
// 기존 me 응답(id/email/username)에 emailVerified 만 additive 로 더한다.
export const MeResponseSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  username: z.string().min(2).max(32),
  emailVerified: z.boolean(),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

// S66 (D13 / FR-W05b): GET /auth/verify-email?token= 성공 응답. 인증 완료 후
// 클라이언트가 진입 재시도하도록 emailVerified=true 를 echo 한다.
export const VerifyEmailResponseSchema = z.object({
  emailVerified: z.literal(true),
});
export type VerifyEmailResponse = z.infer<typeof VerifyEmailResponseSchema>;

// S66 (D13 / FR-W05b): POST /auth/resend-verification 응답. 재발송 직후 다음
// 재발송까지 남은 쿨다운 초(cooldownSec)와 그날 남은 재발송 횟수(remainingToday)를
// 돌려줘 클라이언트가 60초 카운트다운·소진 안내를 그릴 수 있게 한다.
export const VerificationResendResponseSchema = z.object({
  cooldownSec: z.number().int().nonnegative(),
  remainingToday: z.number().int().nonnegative(),
});
export type VerificationResendResponse = z.infer<typeof VerificationResendResponseSchema>;

// S66 (D13): 이메일 인증 재발송 정책 상수(단일 출처 — BE rate-limit + FE 카운트다운
// 표기가 공유). 60초 쿨다운, 1일 최대 5회.
export const EMAIL_VERIFY_RESEND_COOLDOWN_SEC = 60;
export const EMAIL_VERIFY_RESEND_DAILY_MAX = 5;
// 인증 토큰 유효기간(24h). EmailVerificationService 가 만료 판정에 쓴다.
export const EMAIL_VERIFY_TOKEN_TTL_SEC = 24 * 60 * 60;

export const AuthTokensResponseSchema = z.object({
  accessToken: z.string().min(10),
  user: AuthUserSchema,
});
export type AuthTokensResponse = z.infer<typeof AuthTokensResponseSchema>;

export const RefreshResponseSchema = z.object({
  accessToken: z.string().min(10),
});
export type RefreshResponse = z.infer<typeof RefreshResponseSchema>;
