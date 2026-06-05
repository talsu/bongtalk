import { z } from 'zod';
import { PasswordSchema } from './auth';

/**
 * S77b (D14 / FR-PS-15·20): 보안 설정 컨트랙트 — 자격증명 변경 · TOTP 2FA · 세션 관리.
 *
 * 서버(apps/api)와 클라이언트(apps/web)가 공유하는 단일 출처다. class-validator DTO 대신
 * 컨트롤러에서 safeParse 로 검증하는 기존 settings 패턴(PrivacySettings)을 따른다.
 *
 *   POST   /api/v1/users/me/change-password  ChangePasswordRequest
 *   POST   /api/v1/users/me/change-email     ChangeEmailRequest
 *   POST   /api/v1/users/me/2fa/totp/setup   → TotpSetupResponse
 *   POST   /api/v1/users/me/2fa/totp/verify  TotpVerifyRequest → TotpVerifyResponse
 *   DELETE /api/v1/users/me/2fa/totp         TotpDisableRequest
 *   GET    /api/v1/users/me/2fa              → TwoFactorStatus
 *   GET    /api/v1/users/me/sessions         → SessionListResponse
 *   DELETE /api/v1/users/me/sessions/:id     → 개별 세션 로그아웃
 *   DELETE /api/v1/users/me/sessions         → 현재 제외 전체 로그아웃
 */

// ── 백업코드 개수 단일 출처(BE 생성 + FE 표시 검증 공유) ──────────────────────
export const TOTP_BACKUP_CODE_COUNT = 10;
// 백업코드 1개 길이(평문 hex). BE 생성·FE 그리드 표시가 공유한다.
export const TOTP_BACKUP_CODE_LENGTH = 10;
// TOTP 코드 길이(RFC6238 기본 6자리).
export const TOTP_CODE_LENGTH = 6;
// Redis 에 보관하는 setup 시크릿 TTL(초). 10분.
export const TOTP_SETUP_TTL_SEC = 10 * 60;

// ── 자격증명 변경 ────────────────────────────────────────────────────────────
// SF3 (security HIGH-3): 2FA 활성 사용자는 비번 변경 시 totpCode 재확인이 필수다. 스키마에선
// optional 로 두고(2FA 미활성 사용자는 누락도 well-formed) 서버가 totpEnabled 를 보고 강제한다
// (누락 403 TOTP_CODE_REQUIRED · 불일치 403 TOTP_INVALID).
export const ChangePasswordRequestSchema = z
  .object({
    currentPassword: z.string().min(1).max(128),
    // newPassword 정책은 PasswordSchema(min 8 · max 128)를 재사용한다.
    newPassword: PasswordSchema,
    totpCode: z.string().length(TOTP_CODE_LENGTH).regex(/^\d+$/, 'code must be digits').optional(),
  })
  .strict();
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;

// SF2 (security HIGH-2): 동일하게 이메일 변경도 2FA 활성 시 totpCode 재확인 필수(optional 스키마
// + 서버 강제).
export const ChangeEmailRequestSchema = z
  .object({
    currentPassword: z.string().min(1).max(128),
    newEmail: z.string().email(),
    totpCode: z.string().length(TOTP_CODE_LENGTH).regex(/^\d+$/, 'code must be digits').optional(),
  })
  .strict();
export type ChangeEmailRequest = z.infer<typeof ChangeEmailRequestSchema>;

// 자격증명 변경 응답(이메일은 인증메일 발송까지만 — 확인 콜백은 OUT/S77c).
export const ChangeEmailResponseSchema = z.object({
  // 인증메일을 발송한 대상(신규 이메일). 확인 전까지 기존 이메일이 유효하다.
  pendingEmail: z.string().email(),
});
export type ChangeEmailResponse = z.infer<typeof ChangeEmailResponseSchema>;

// ── TOTP 2FA ────────────────────────────────────────────────────────────────
export const TotpSetupResponseSchema = z.object({
  // otpauth://totp/... URI(인증 앱 수동 입력/QR 디코드용).
  otpauthUri: z.string().min(1),
  // base32 시크릿(QR 스캔 불가 시 수동 입력용).
  secret: z.string().min(1),
  // 서버가 otpauthUri 를 렌더한 QR data-URI(image/png). FE 가 <img src> 로 표시한다.
  qrDataUri: z.string().min(1),
});
export type TotpSetupResponse = z.infer<typeof TotpSetupResponseSchema>;

export const TotpVerifyRequestSchema = z
  .object({
    code: z.string().length(TOTP_CODE_LENGTH).regex(/^\d+$/, 'code must be digits'),
  })
  .strict();
export type TotpVerifyRequest = z.infer<typeof TotpVerifyRequestSchema>;

export const TotpVerifyResponseSchema = z.object({
  totpEnabled: z.literal(true),
  // 평문 백업코드(1회 반환·재조회 불가). FE 가 저장 확인 후 폐기한다.
  backupCodes: z.array(z.string()).length(TOTP_BACKUP_CODE_COUNT),
});
export type TotpVerifyResponse = z.infer<typeof TotpVerifyResponseSchema>;

export const TotpDisableRequestSchema = z
  .object({
    currentPassword: z.string().min(1).max(128),
    // 해제는 비번 + TOTP 코드 동시 필수. 누락 시 서버가 403 TOTP_CODE_REQUIRED.
    // 스키마에선 optional 로 두고(누락도 well-formed) 서버가 도메인 거부한다.
    totpCode: z.string().length(TOTP_CODE_LENGTH).regex(/^\d+$/, 'code must be digits').optional(),
  })
  .strict();
export type TotpDisableRequest = z.infer<typeof TotpDisableRequestSchema>;

export const TwoFactorStatusSchema = z.object({
  totpEnabled: z.boolean(),
});
export type TwoFactorStatus = z.infer<typeof TwoFactorStatusSchema>;

// ── 세션 관리 ────────────────────────────────────────────────────────────────
export const SessionSummarySchema = z.object({
  id: z.string().uuid(),
  // userAgent 파싱 결과(브라우저/OS 요약) 또는 raw. null = 미상.
  deviceName: z.string().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: z.string().datetime(),
  lastSeenAt: z.string().datetime().nullable(),
  // 현재 요청을 발급한 RefreshToken 패밀리(현재 세션)인지 여부.
  isCurrent: z.boolean(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

export const SessionListResponseSchema = z.object({
  sessions: z.array(SessionSummarySchema),
});
export type SessionListResponse = z.infer<typeof SessionListResponseSchema>;

// ── 계정 비활성화/재활성화 (S77c · D14 / FR-PS-16) ───────────────────────────
//
//   POST /api/v1/users/me/deactivate  DeactivateAccountRequest → 204
//   POST /api/v1/users/me/reactivate  ReactivateAccountRequest → 204
//
// 둘 다 현재 비밀번호 재확인이 필수다. 2FA 활성 사용자는 totpCode 도 재확인한다(S77b 패턴 일관 —
// 스키마에선 optional 로 두고 서버가 totpEnabled 를 보고 강제: 누락 403 TOTP_CODE_REQUIRED ·
// 불일치 403 TOTP_INVALID). reactivate 는 비활성 계정이 로그인 차단되므로(ACCOUNT_DEACTIVATED)
// 로그인 자격증명(email+password)을 함께 받아 검증 후 복구한다.
export const DeactivateAccountRequestSchema = z
  .object({
    currentPassword: z.string().min(1).max(128),
    totpCode: z.string().length(TOTP_CODE_LENGTH).regex(/^\d+$/, 'code must be digits').optional(),
  })
  .strict();
export type DeactivateAccountRequest = z.infer<typeof DeactivateAccountRequestSchema>;

export const ReactivateAccountRequestSchema = z
  .object({
    // 비활성 계정은 인증 컨텍스트가 없으므로(로그인 차단) 로그인 자격증명을 함께 받는다.
    email: z.string().email(),
    password: z.string().min(1).max(128),
    totpCode: z.string().length(TOTP_CODE_LENGTH).regex(/^\d+$/, 'code must be digits').optional(),
  })
  .strict();
export type ReactivateAccountRequest = z.infer<typeof ReactivateAccountRequestSchema>;
