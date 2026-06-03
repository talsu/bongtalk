import { z } from 'zod';

/**
 * S63 (D12 / FR-RM05·06·07): 모더레이션(Kick / Ban / Timeout) 단일 출처(shared-types).
 *
 * 권한 비트(KICK_MEMBERS / BAN_MEMBERS / TIMEOUT_MEMBERS)는 ADR-4 카탈로그
 * (`permissions.ts`)에 정의되며 여기서 재정의하지 않습니다. 요청 스키마·응답 DTO·
 * WS 페이로드만 모읍니다.
 */

/** S63 (FR-RM05/06): 사유 최대 길이(≤512자, 선택). 공백 trim 후 길이 검증. */
export const MODERATION_REASON_MAX = 512;

/** S63 (FR-RM07): 타임아웃 기간 하한 60초 · 상한 7일(604800초). */
export const TIMEOUT_MIN_SECONDS = 60;
export const TIMEOUT_MAX_SECONDS = 604800;

/** S63 (FR-RM05): kick undo 토큰 TTL(초). actor 소켓에만 전달되는 5초 윈도. */
export const KICK_UNDO_TTL_SECONDS = 5;

/** S63: 선택 사유 — undefined 허용, 제공 시 1~512자(trim). 빈 문자열은 미제공 취급. */
const ReasonSchema = z
  .string()
  .trim()
  .max(MODERATION_REASON_MAX, `reason must be at most ${MODERATION_REASON_MAX} characters`)
  .optional();

/** S63 (FR-RM05): Kick 요청 바디. 사유 선택. */
export const KickMemberRequestSchema = z.object({
  reason: ReasonSchema,
});
export type KickMemberRequest = z.infer<typeof KickMemberRequestSchema>;

/** S63 (FR-RM05): Kick 응답 — actor 에게만 돌려주는 5초 Undo 토큰. */
export const KickMemberResponseSchema = z.object({
  /** Undo 에 사용하는 1회용 토큰(Redis TTL 5초). 만료/사용 후 409. */
  undoToken: z.string(),
  /** 만료 시각(ISO UTC). FE 가 토스트 카운트다운에 사용. */
  undoExpiresAt: z.string().datetime(),
});
export type KickMemberResponse = z.infer<typeof KickMemberResponseSchema>;

/** S63 (FR-RM05): Kick Undo 요청 바디 — POST kick-undo. */
export const KickUndoRequestSchema = z.object({
  undoToken: z.string().min(1, 'undoToken is required'),
});
export type KickUndoRequest = z.infer<typeof KickUndoRequestSchema>;

/** S63 (FR-RM06): Ban 요청 바디 — 멤버/비멤버 userId 대상. 사유 선택. */
export const BanMemberRequestSchema = z.object({
  userId: z.string().uuid(),
  reason: ReasonSchema,
});
export type BanMemberRequest = z.infer<typeof BanMemberRequestSchema>;

/** S63 (FR-RM06): 차단 목록 항목 DTO. */
export const BannedMemberSchema = z.object({
  workspaceId: z.string().uuid(),
  userId: z.string().uuid(),
  bannedBy: z.string().uuid(),
  reason: z.string().nullable(),
  createdAt: z.string().datetime(),
  /** 차단 대상 사용자 표시 정보(비멤버 차단도 사용자 행은 존재). */
  user: z
    .object({
      id: z.string().uuid(),
      username: z.string(),
      email: z.string().email(),
    })
    .nullable(),
});
export type BannedMember = z.infer<typeof BannedMemberSchema>;

export const ListBansResponseSchema = z.object({
  bans: z.array(BannedMemberSchema),
});
export type ListBansResponse = z.infer<typeof ListBansResponseSchema>;

/**
 * S63 (FR-RM07): Timeout 요청 바디. durationSeconds 는 60~604800. 서버가
 * expiresAt = now + durationSeconds 로 환산한다. 사유 선택.
 */
export const TimeoutMemberRequestSchema = z.object({
  durationSeconds: z
    .number()
    .int()
    .min(TIMEOUT_MIN_SECONDS, `durationSeconds must be at least ${TIMEOUT_MIN_SECONDS}`)
    .max(TIMEOUT_MAX_SECONDS, `durationSeconds must be at most ${TIMEOUT_MAX_SECONDS}`),
  reason: ReasonSchema,
});
export type TimeoutMemberRequest = z.infer<typeof TimeoutMemberRequestSchema>;

/** S63 (FR-RM07): Timeout 응답 — 적용된 만료 시각. */
export const TimeoutMemberResponseSchema = z.object({
  userId: z.string().uuid(),
  /** 음소거 만료 시각(ISO UTC). lazy 체크 — 이 시각 후 자동 통과. */
  mutedUntil: z.string().datetime(),
});
export type TimeoutMemberResponse = z.infer<typeof TimeoutMemberResponseSchema>;

/**
 * S63 (FR-RM07): FE duration picker 프리셋. 60초/5분/10분/1시간/1일/7일.
 * 라벨은 폴라이트 한국어, 값은 초.
 */
export const TIMEOUT_DURATION_PRESETS: ReadonlyArray<{ label: string; seconds: number }> = [
  { label: '60초', seconds: 60 },
  { label: '5분', seconds: 300 },
  { label: '10분', seconds: 600 },
  { label: '1시간', seconds: 3600 },
  { label: '1일', seconds: 86400 },
  { label: '7일', seconds: 604800 },
];
