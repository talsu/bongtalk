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

// ───────────────────────────────── S64 (D12 / FR-RM09) Bulk Purge ───────────

/** S64 (FR-RM09): 단일 bulk purge 요청의 최대 메시지 수. 초과 시 400 BULK_DELETE_LIMIT. */
export const BULK_DELETE_MAX = 200;

/**
 * S64 (FR-RM09): 채널 메시지 일괄 soft-delete 요청. 두 가지 모드 중 하나:
 *   - messageIds: 명시한 메시지 id 배열(≤200). 채널/미삭제 교집합만 삭제.
 *   - latest: 채널 최신 N개(≤200) soft-delete.
 * 둘 중 정확히 하나만 제공해야 한다(superRefine).
 */
export const BulkDeleteRequestSchema = z
  .object({
    messageIds: z.array(z.string().uuid()).min(1).max(BULK_DELETE_MAX).optional(),
    latest: z.number().int().min(1).max(BULK_DELETE_MAX).optional(),
  })
  .superRefine((val, ctx) => {
    const hasIds = val.messageIds !== undefined;
    const hasLatest = val.latest !== undefined;
    if (hasIds === hasLatest) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'provide exactly one of messageIds or latest',
      });
    }
  });
export type BulkDeleteRequest = z.infer<typeof BulkDeleteRequestSchema>;

/** S64 (FR-RM09): bulk purge 응답 — 실제 soft-delete 된 메시지 id 들과 개수. */
export const BulkDeleteResponseSchema = z.object({
  deletedCount: z.number().int().nonnegative(),
  messageIds: z.array(z.string().uuid()),
});
export type BulkDeleteResponse = z.infer<typeof BulkDeleteResponseSchema>;

// ─────────────────────────────── S64 (D12 / FR-RM11) 신고 큐 ─────────────────

/** S64 (FR-RM11): 신고 카테고리. */
export const REPORT_CATEGORIES = [
  'SPAM',
  'HARASSMENT',
  'HATE_SPEECH',
  'INAPPROPRIATE',
  'OTHER',
] as const;
export const ReportCategorySchema = z.enum(REPORT_CATEGORIES);
export type ReportCategory = z.infer<typeof ReportCategorySchema>;

/** S64 (FR-RM11): 신고 카테고리 한국어 라벨(FE 표시용). */
export const REPORT_CATEGORY_LABELS: Record<ReportCategory, string> = {
  SPAM: '스팸',
  HARASSMENT: '괴롭힘',
  HATE_SPEECH: '혐오 발언',
  INAPPROPRIATE: '부적절한 콘텐츠',
  OTHER: '기타',
};

/** S64 (FR-RM11): 모더레이터가 신고를 처리할 때 선택하는 액션. */
export const REPORT_ACTIONS = ['DISMISS', 'WARN', 'DELETE_MESSAGE', 'TIMEOUT', 'BAN'] as const;
export const ReportActionSchema = z.enum(REPORT_ACTIONS);
export type ReportAction = z.infer<typeof ReportActionSchema>;

/** S64 (FR-RM11): 신고 처리 액션 한국어 라벨(FE 표시용). */
export const REPORT_ACTION_LABELS: Record<ReportAction, string> = {
  DISMISS: '기각',
  WARN: '경고',
  DELETE_MESSAGE: '메시지 삭제',
  TIMEOUT: '타임아웃',
  BAN: '차단',
};

/** S64 (FR-RM11): 메시지 신고 생성 요청. reason 은 선택(≤512자, trim). */
export const ReportMessageRequestSchema = z.object({
  category: ReportCategorySchema,
  reason: ReasonSchema,
});
export type ReportMessageRequest = z.infer<typeof ReportMessageRequestSchema>;

/**
 * S64 (FR-RM11): 신고 처리 요청. action 별 부가 입력:
 *   - TIMEOUT: durationSeconds 필수(60~604800).
 *   - 그 외: durationSeconds 무시.
 *   - reason: 모든 액션에 선택(처리 사유 — AuditLog details 에 기록).
 */
export const ResolveReportRequestSchema = z
  .object({
    action: ReportActionSchema,
    reason: ReasonSchema,
    durationSeconds: z.number().int().min(TIMEOUT_MIN_SECONDS).max(TIMEOUT_MAX_SECONDS).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.action === 'TIMEOUT' && val.durationSeconds === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'durationSeconds is required for TIMEOUT action',
        path: ['durationSeconds'],
      });
    }
  });
export type ResolveReportRequest = z.infer<typeof ResolveReportRequestSchema>;

/** S64 (FR-RM11): 신고 큐 항목 DTO. resolved* 는 미처리 시 null. */
export const ModerationReportSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  messageId: z.string().uuid(),
  channelId: z.string().uuid(),
  // S64 fix-forward (security A-6 = MEDIUM-2): 신고자 계정 삭제 시 ON DELETE SET NULL
  // 로 익명화되어 null 일 수 있다.
  reporterId: z.string().uuid().nullable(),
  category: ReportCategorySchema,
  reason: z.string().nullable(),
  createdAt: z.string().datetime(),
  resolvedAt: z.string().datetime().nullable(),
  resolvedBy: z.string().uuid().nullable(),
  resolvedAction: ReportActionSchema.nullable(),
  /**
   * 신고된 메시지의 작성자 + 본문 스냅샷(삭제 메시지는 null content).
   *
   * S64 fix-forward (security A-2 = BLOCKER-2): private 채널 비멤버 모더레이터에게는
   * content 가 마스킹된다(content=null + contentMasked=true). FE 는 contentMasked 가
   * true 면 '[비공개 채널 메시지]' 로 표시한다(삭제 메시지의 '[삭제된 메시지]' 와 구분).
   */
  message: z
    .object({
      authorId: z.string().uuid(),
      content: z.string().nullable(),
      deleted: z.boolean(),
      /** content 가 채널 ACL 로 마스킹됐는지(비공개 채널 비멤버). */
      contentMasked: z.boolean(),
    })
    .nullable(),
  /** 신고자 표시 정보(계정 삭제·익명화 시 null). */
  reporter: z
    .object({
      id: z.string().uuid(),
      username: z.string(),
    })
    .nullable(),
});
export type ModerationReport = z.infer<typeof ModerationReportSchema>;

/** S64 fix-forward (B-4 = MODERATE-4): 신고 큐 한 페이지 기본/최대 항목 수. */
export const REPORT_QUEUE_PAGE_DEFAULT = 50;
export const REPORT_QUEUE_PAGE_MAX = 100;

/** S64 (FR-RM11): 신고 큐 필터 — 미처리만/전체. */
export const ReportQueueFilterSchema = z.enum(['OPEN', 'ALL']);
export type ReportQueueFilter = z.infer<typeof ReportQueueFilterSchema>;

/**
 * S64 fix-forward (B-4 = MODERATE-4 = security MEDIUM-4 = reviewer m-3): 신고 큐 조회
 * 쿼리. take:200 하드리밋을 audit 와 동일한 cursor 페이지네이션으로 대체한다.
 * cursor 는 opaque base64url(JSON{resolvedAt,createdAt,id}) 다음 페이지 토큰.
 */
export const ListReportsQuerySchema = z.object({
  filter: ReportQueueFilterSchema.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(REPORT_QUEUE_PAGE_MAX).optional(),
});
export type ListReportsQuery = z.infer<typeof ListReportsQuerySchema>;

/** S64 (FR-RM11): 신고 큐 목록 응답(미처리 우선·최신순). nextCursor null = 마지막 페이지. */
export const ListReportsResponseSchema = z.object({
  reports: z.array(ModerationReportSchema),
  /** S64 fix-forward (B-4): 다음 페이지 cursor. 없으면 null. */
  nextCursor: z.string().nullable(),
});
export type ListReportsResponse = z.infer<typeof ListReportsResponseSchema>;
