import { z } from 'zod';

export const UuidSchema = z.string().uuid();

export const UserSchema = z.object({
  id: UuidSchema,
  email: z.string().email(),
  username: z.string().min(2).max(32),
  createdAt: z.string().datetime(),
});
export type User = z.infer<typeof UserSchema>;

// task-031-A: Workspace + WorkspaceSchema are defined in ./workspace
// and re-exported via `export * from './workspace'` below. The previous
// duplicate here shadowed the richer schema (visibility + category
// were missing from the type that 030 added).

// Channel/ChannelType schemas were moved to `./channel.ts` in task-003 and
// are re-exported at the bottom of this file.

// Message schemas moved to `./message.ts` in task-004 — re-exported at EOF.

export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
  uptime: z.number(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const ReadyResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  checks: z.object({
    db: z.enum(['ok', 'fail']),
    redis: z.enum(['ok', 'fail']),
    // task-020-A: outbox reports three-state now — "ok" = healthy or
    // draining, "idle" = empty backlog + quiet dispatcher, "stalled"
    // = backlog + no tick. Frontend health pages + smoke scripts can
    // branch on all three.
    outbox: z.enum(['ok', 'idle', 'stalled']),
  }),
  details: z
    .object({
      outbox: z.string().optional(),
    })
    .optional(),
});
export type ReadyResponse = z.infer<typeof ReadyResponseSchema>;

export const ErrorCodeSchema = z.enum([
  'AUTH_INVALID_TOKEN',
  'AUTH_EMAIL_TAKEN',
  'AUTH_USERNAME_TAKEN',
  'AUTH_WEAK_PASSWORD',
  'AUTH_INVALID_CREDENTIALS',
  'AUTH_ACCOUNT_LOCKED',
  'AUTH_SESSION_COMPROMISED',
  'WORKSPACE_NOT_FOUND',
  'WORKSPACE_NOT_MEMBER',
  'WORKSPACE_SLUG_TAKEN',
  'WORKSPACE_SLUG_RESERVED',
  'WORKSPACE_INSUFFICIENT_ROLE',
  'WORKSPACE_CANNOT_DEMOTE_OWNER',
  'WORKSPACE_CANNOT_REMOVE_OWNER',
  'WORKSPACE_OWNER_MUST_TRANSFER',
  'WORKSPACE_TARGET_NOT_MEMBER',
  'WORKSPACE_ALREADY_MEMBER',
  'WORKSPACE_PURGED',
  'WORKSPACE_NOT_PUBLIC',
  'FRIEND_TARGET_NOT_FOUND',
  'FRIEND_CANNOT_SELF',
  'FRIEND_ALREADY',
  'FRIEND_BLOCKED',
  'FRIEND_REQUEST_DUPLICATE',
  'FRIEND_NOT_FOUND',
  'FRIEND_INVALID_STATE',
  'FRIEND_CAP_REACHED',
  // S16 (FR-DM-02): 그룹 DM 구성원 cap 초과 → 422.
  'DM_GROUP_CAP_EXCEEDED',
  // S19 (FR-DM-12): DM 수신권한(allowDmFrom) 미충족 → 403. 클라이언트는 이 코드를
  // 받으면 "상대가 DM 수신을 제한함" 안내로 분기한다(friend-gate 404 와 구분).
  'DM_PRIVACY_RESTRICTED',
  'INVITE_NOT_FOUND',
  'INVITE_EXPIRED',
  'INVITE_EXHAUSTED',
  // task-015-A (014-follow-3 closure): these existed on the backend
  // enum + HTTP map but were missing from the shared schema, so the
  // web client could not safely branch on them. A unit regression
  // guard in `error-code-schema.unit.spec.ts` stops future drift.
  'INVITE_REVOKED',
  // task-016-C-2: closed-beta gate on POST /auth/signup when
  // BETA_INVITE_REQUIRED=true. Client maps this to a support-email
  // link instead of a retry-able error.
  'BETA_INVITE_REQUIRED',
  'CHANNEL_NOT_FOUND',
  'CHANNEL_NAME_TAKEN',
  'CHANNEL_NAME_INVALID',
  'CHANNEL_TYPE_NOT_IMPLEMENTED',
  'CHANNEL_PURGED',
  'CHANNEL_POSITION_INVALID',
  'CHANNEL_ARCHIVED',
  // S13 (FR-CH-19): ANNOUNCEMENT 채널 게시 제한 → 403. 클라이언트는 이 코드를
  // 받으면 "공지 채널은 관리자만 게시" 안내로 분기한다(일반 FORBIDDEN 과 구분).
  'CHANNEL_POSTING_RESTRICTED',
  // S14 (FR-CH-05): 비공개→공개 전환 confirmName 누락/불일치 → 400. 클라이언트는
  // 이 코드를 받으면 "채널 이름 재입력" confirm 모달의 검증 실패로 분기한다.
  'CHANNEL_CONFIRM_REQUIRED',
  // S14 (FR-CH-07): 비공개 채널 자유 가입 거부 → 403(초대 기반 가입만).
  'CHANNEL_PRIVATE_INVITE_ONLY',
  // S14 (FR-CH-07): 비멤버 탈퇴 → 409.
  'CHANNEL_NOT_MEMBER',
  // S15 (FR-CH-08): 슬로우모드 활성 중 재송신 → 429 + retryAfterMs.
  'CHANNEL_SLOWMODE_ACTIVE',
  'CATEGORY_NOT_FOUND',
  'CATEGORY_NAME_TAKEN',
  // S43 (FR-CH-15): 즐겨찾기 재정렬 anchor 미존재 → 404.
  'FAVORITE_NOT_FOUND',
  'MESSAGE_NOT_FOUND',
  'MESSAGE_CONTENT_INVALID',
  'MESSAGE_CURSOR_INVALID',
  // S02 (FR-MSG-03 / FR-MSG-20): contentPlain 4,000자 초과 시 400.
  'MESSAGE_TOO_LONG',
  // S00 (FR-MSG-23): mrkdwn 파서 ReDoS 방어 한도 초과. 모두 400.
  // 한도/매핑은 packages/shared-types/src/mrkdwn.ts MRKDWN_PARSE_LIMITS.
  'PARSE_TIMEOUT',
  'PARSE_DEPTH_EXCEEDED',
  'PARSE_NODE_LIMIT',
  'PARSE_AST_TOO_LARGE',
  'MESSAGE_NOT_AUTHOR',
  'MESSAGE_THREAD_DEPTH_EXCEEDED',
  'MESSAGE_PARENT_NOT_FOUND',
  // S38 (FR-TH-13): 잠긴 스레드 답글 차단(MEMBER 이하).
  'THREAD_LOCKED',
  // task-044-iter2: pinned messages cap (50/channel)
  'MESSAGE_PIN_CAP_EXCEEDED',
  // S05 (FR-MSG-06): 낙관적 잠금 충돌. PATCH expectedVersion 이 서버
  // version 과 불일치 → 409. 응답은 표준 에러 envelope + `details.current`
  // 에 현재 MessageDto 를 실어 클라이언트가 편집창을 최신값으로 롤백.
  'MESSAGE_VERSION_CONFLICT',
  'IDEMPOTENCY_KEY_REUSE_CONFLICT',
  // S39 (FR-RE02 / D05): 메시지당 고유 이모지 반응 종류 한도(20) 초과 → 409.
  // INSERT ON CONFLICT DO NOTHING 후 단일 tx 내 COUNT … FOR UPDATE 로 20 초과를
  // 감지하면 방금 삽입한 행을 DELETE 한 뒤 이 코드로 거부한다(D12 FR-RM16 패턴).
  'REACTION_LIMIT_REACHED',
  // task-015-A (014-follow-3 closure): attachments + channel
  // visibility + generic forbidden codes. All existed in the backend
  // enum from task-012; schema drift hid them from the client.
  'ATTACHMENT_NOT_FOUND',
  'ATTACHMENT_TOO_LARGE',
  'ATTACHMENT_MIME_REJECTED',
  'ATTACHMENT_NOT_UPLOADED',
  'ATTACHMENT_SIZE_MISMATCH',
  'CHANNEL_NOT_VISIBLE',
  // task-037-D custom emoji
  'CUSTOM_EMOJI_NOT_FOUND',
  'CUSTOM_EMOJI_NAME_TAKEN',
  'CUSTOM_EMOJI_NAME_INVALID',
  // S41 (FR-EM02): 워크스페이스당 커스텀 이모지 100개 한도 초과 → 409. PRD 정본
  // 코드(종전 CUSTOM_EMOJI_CAP_REACHED 422 정합).
  'EMOJI_WORKSPACE_LIMIT',
  // S41 (FR-EM01 / FR-RC20): 업로드 MIME/size 거부 → 422. PRD 정본 코드
  // (종전 CUSTOM_EMOJI_MIME_REJECTED 415 / CUSTOM_EMOJI_TOO_LARGE 413 정합).
  'INVALID_FILE',
  // S42 (FR-EM05): 별칭 한도(이모지당 10개) 초과 / 충돌(다른 별칭 또는 name) → 409.
  'ALIAS_LIMIT',
  'ALIAS_CONFLICT',
  // task-038-B magic-byte validation
  'INVALID_MAGIC_BYTES',
  // S48 (FR-MN-10): 키워드 알림 등록 한도(25개) 초과 → 400.
  'KEYWORD_LIMIT_EXCEEDED',
  // S51 (FR-PS-07): 개인 저장함 항목 수 한도(500) 초과 → 422.
  'SAVED_LIMIT_EXCEEDED',
  // S52 (FR-PS-08): PATCH 대상 저장 항목이 본인 소유가 아니거나 없음 → 404.
  'SAVED_NOT_FOUND',
  'FORBIDDEN',
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'RATE_LIMITED',
  'INTERNAL',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ErrorResponseSchema = z.object({
  errorCode: ErrorCodeSchema,
  message: z.string(),
  requestId: z.string(),
  retryAfterSec: z.number().int().positive().optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export * from './auth';
export * from './workspace';
export * from './channel';
export * from './message';
export * from './presence';
export * from './notifications';
// S00 — shared-types 컨트랙트 수렴 (ADR-4 / ADR-8 / ADR-12 + FR-RC22/RC23/MSG-23)
export * from './permissions';
export * from './constants';
export * from './mrkdwn';
export * from './events';
// S01 — 카노니컬 additive 토대 (ADR-2 / ADR-11 + FR-RC02)
export * from './mrkdwn-ast';
export * from './bigint';
// S02 — mrkdwn 송수신 코어 파서 (FR-MSG-01 / FR-MSG-03 / FR-MSG-20 / FR-MSG-23)
export * from './mrkdwn-parser';
// S04 — MessageType enum 단일 정의 (ADR-2 / FR-MSG-19 / FR-RC10)
export * from './message-type';
// S51 — 개인 저장함 컨트랙트 (D10 / FR-PS-07)
export * from './saved-message';
