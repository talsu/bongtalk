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

// AUTH-3 (PRD D18 §5 / FR-AUTH-40~44): 비밀번호 재설정(미인증/비로그인) 플로우.
//
// POST /auth/forgot-password: 계정 존재 여부와 무관하게 항상 200(계정 열거 방어 — 존재하고
// 활성일 때만 PasswordResetToken 발급 + 메일). POST /auth/reset-password: token+password 검증
// 후 단일 tx CAS 로 1회 소모 + argon2 재해싱 + 전 RefreshToken revoke(전 기기 강제 로그아웃).
//
// 토큰 TTL 은 인증 토큰(24h)보다 짧은 1h(보안 — 재설정은 즉시 사용을 전제). raw 토큰은
// 절대 저장하지 않고 sha256 해시만 저장한다(EmailVerificationToken 의 uuid+@unique 와 달리
// invite 의 tokenHash 패턴을 따른다 — DB 유출 시 토큰 역산 방지).
export const PASSWORD_RESET_TOKEN_TTL_SEC = 60 * 60;

// AUTH-3 (contract HIGH): forgot-password 이메일당 재요청 쿨다운(초). 메일 폭탄/타이밍
// 누출 방지용으로 PasswordResetService 가 Redis NX 점유 TTL 에 쓴다. 단일 출처(shared-types)
// 로 두어 BE 쿨다운과 FE 표기가 어긋나지 않게 한다(EMAIL_VERIFY_RESEND_COOLDOWN_SEC 패턴).
export const PASSWORD_RESET_RESEND_COOLDOWN_SEC = 60;

// POST /auth/forgot-password 요청 — 이메일만 받는다.
export const ForgotPasswordRequestSchema = z.object({
  email: z.string().email(),
});
export type ForgotPasswordRequest = z.infer<typeof ForgotPasswordRequestSchema>;

// POST /auth/forgot-password 응답 — 항상 { ok: true }(존재 여부 비노출).
export const ForgotPasswordResponseSchema = z.object({
  ok: z.literal(true),
});
export type ForgotPasswordResponse = z.infer<typeof ForgotPasswordResponseSchema>;

// POST /auth/reset-password 요청 — token + 새 비밀번호(정책 = PasswordSchema min(8)).
export const ResetPasswordRequestSchema = z.object({
  token: z.string().min(1),
  password: PasswordSchema,
});
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequestSchema>;

// POST /auth/reset-password 성공 응답 — { ok: true }(클라가 /login 으로 이동).
export const ResetPasswordResponseSchema = z.object({
  ok: z.literal(true),
});
export type ResetPasswordResponse = z.infer<typeof ResetPasswordResponseSchema>;

export const AuthTokensResponseSchema = z.object({
  accessToken: z.string().min(10),
  user: AuthUserSchema,
});
export type AuthTokensResponse = z.infer<typeof AuthTokensResponseSchema>;

export const RefreshResponseSchema = z.object({
  accessToken: z.string().min(10),
});
export type RefreshResponse = z.infer<typeof RefreshResponseSchema>;
