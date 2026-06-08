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
  // S66 (D13 / FR-W05a/W05b/W21): 이메일 인증 + 도메인 게이트.
  // EMAIL_NOT_VERIFIED: emailVerified=false 사용자의 워크스페이스 진입(JOIN·ACCEPT·
  //   DOMAIN_JOIN) / 채널 메시지 전송 차단 → 403. 클라이언트는 인증 대기 화면으로 분기.
  // WORKSPACE_DOMAIN_NOT_ALLOWED: 워크스페이스 emailDomains 화이트리스트(exact match)
  //   불일치 → 403. emailDomains 빈 배열이면 제한 없음(이 코드 미발생).
  // EMAIL_VERIFICATION_RATE_LIMITED: 재발송 쿨다운(60s)/일일한도(5회) 초과 → 429.
  // EMAIL_VERIFICATION_TOKEN_EXPIRED: 인증 토큰 만료(24h 경과) → 410.
  // EMAIL_VERIFICATION_TOKEN_INVALID: 토큰 미존재/형식오류/이미 사용됨 → 400.
  'EMAIL_NOT_VERIFIED',
  'WORKSPACE_DOMAIN_NOT_ALLOWED',
  'EMAIL_VERIFICATION_RATE_LIMITED',
  'EMAIL_VERIFICATION_TOKEN_EXPIRED',
  'EMAIL_VERIFICATION_TOKEN_INVALID',
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
  // S65 (D13 / FR-W19): 기본 채널 변경 대상이 비공개 채널일 때.
  'WORKSPACE_DEFAULT_CHANNEL_NOT_PUBLIC',
  // S65 fix-forward (security A-2): joinMode=APPLY 즉시 가입 차단(409).
  'WORKSPACE_APPLY_NOT_SUPPORTED',
  // S65 fix-forward (D-2): PUBLIC 전환 시 category/description 누락(422).
  'WORKSPACE_PUBLIC_REQUIRES_METADATA',
  // S72 (D13 / FR-W15): 삭제 confirmation(= slug) 불일치(422).
  'WORKSPACE_CONFIRMATION_MISMATCH',
  // S61 (D12 / FR-RM01·04·15): 커스텀 Role 시스템 에러 코드.
  'ROLE_NOT_FOUND',
  'ROLE_NAME_TAKEN',
  'ROLE_SYSTEM_IMMUTABLE',
  'ROLE_PRIVILEGE_ESCALATION',
  'ROLE_POSITION_TOO_HIGH',
  'ROLE_INVALID_PERMISSIONS',
  // S63 (D12 / FR-RM05·06·07): 모더레이션(Kick/Ban/Timeout) 에러 코드.
  // MODERATION_TARGET_HIGHER: 대상이 actor 보다 상위 position(403, 계층 방어).
  // MODERATION_CANNOT_SELF: 자기 자신 대상(400). MEMBER_ALREADY_BANNED: 이미 차단(409).
  // MEMBER_NOT_BANNED: unban 대상이 차단돼 있지 않음(404). MEMBER_TIMED_OUT: 음소거
  // 중 메시지/반응/슬래시 시도(403). KICK_UNDO_INVALID: undo 토큰 만료/무효(409).
  'MODERATION_TARGET_HIGHER',
  'MODERATION_CANNOT_SELF',
  'MEMBER_ALREADY_BANNED',
  'MEMBER_NOT_BANNED',
  'MEMBER_TIMED_OUT',
  'KICK_UNDO_INVALID',
  // S64 (D12 / FR-RM09): bulk purge 선택 메시지 개수가 상한(200)을 초과 → 400.
  'BULK_DELETE_LIMIT',
  // S64 (D12 / FR-RM11): 같은 메시지를 같은 신고자가 중복 신고 → 409(@@unique 충돌).
  'REPORT_DUPLICATE',
  // S64 (D12 / FR-RM11): 처리 대상 신고가 없음(타 워크스페이스·삭제·잘못된 id) → 404.
  'REPORT_NOT_FOUND',
  // S64 (D12 / FR-RM11): 이미 처리(resolvedAt 존재)된 신고를 재처리 → 409(상태 충돌).
  'REPORT_ALREADY_RESOLVED',
  'FRIEND_TARGET_NOT_FOUND',
  'FRIEND_CANNOT_SELF',
  'FRIEND_ALREADY',
  'FRIEND_BLOCKED',
  'FRIEND_REQUEST_DUPLICATE',
  'FRIEND_NOT_FOUND',
  'FRIEND_INVALID_STATE',
  'FRIEND_CAP_REACHED',
  // S77a (FR-PS-13): 대상의 친구 요청 수신 정책(allowFriendRequests) 미충족 → 403.
  // NOBODY 거부 / MUTUAL_WORKSPACE 공통 워크스페이스 부재 시 발생(FRIEND_TARGET_NOT_FOUND 404 와 구분).
  'FRIEND_REQUEST_BLOCKED',
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
  // S68 (D13 / FR-W04·W04a·W05): 이메일 직접 초대 + 도메인 관리.
  //   EMAIL_INVITE_TOKEN_INVALID: 토큰/opaque 코드 미존재·취소·sha256 불일치 → 400.
  //   EMAIL_INVITE_EXPIRED: 보류 초대 30일/opaque 10분 만료 → 410.
  //   EMAIL_INVITE_ROLE_MISMATCH: token role ↔ DB role 불일치(위조) → 400.
  //   EMAIL_INVITE_EMAIL_MISMATCH: 수락 actor 이메일 ↔ 초대 대상 이메일 불일치 → 403.
  //     FR-W04a 분기③(다른 계정) 의도를 서버가 강제(가입 시 이메일 변경 우회 차단). FE 는
  //     이 코드를 받으면 "초대받은 이메일로 로그인" 안내로 분기한다.
  //   EMAIL_INVITE_ALREADY_ACCEPTED: 이미 수락된 보류 초대 재수락 → 409.
  //   EMAIL_INVITE_NOT_FOUND: 연장/재발송/취소 대상 보류 초대 미존재 → 404.
  //   WORKSPACE_EMAIL_DOMAINS_FORBIDDEN: emailDomains PATCH 는 OWNER 전용 → 403.
  'EMAIL_INVITE_TOKEN_INVALID',
  'EMAIL_INVITE_EXPIRED',
  'EMAIL_INVITE_ROLE_MISMATCH',
  'EMAIL_INVITE_EMAIL_MISMATCH',
  'EMAIL_INVITE_ALREADY_ACCEPTED',
  'EMAIL_INVITE_NOT_FOUND',
  'WORKSPACE_EMAIL_DOMAINS_FORBIDDEN',
  // S70 (D13 / FR-W06·W06a): 가입 신청(APPLY 모드) 플로우.
  //   APPLICATION_PENDING_EXISTS: 이미 PENDING/INTERVIEW 신청 존재 → 409.
  //   APPLICATION_NOT_FOUND:      처리/취소 대상 신청 미존재(또는 타인) → 404(중립).
  //   APPLICATION_INVALID_STATE:  처리/취소 불가 상태(종결됨/비-PENDING) → 409.
  //   APPLICATION_COOLDOWN:       REJECTED 후 24h 내 재신청 → 429 + retryAfterMs.
  //   APPLICATION_FORBIDDEN:      approve/interview 를 ADMIN 미만이 시도 → 403.
  //   APPLICATION_NOT_APPLICABLE: joinMode 가 APPLY 아닌 워크스페이스 신청 → 409.
  'APPLICATION_PENDING_EXISTS',
  'APPLICATION_NOT_FOUND',
  'APPLICATION_INVALID_STATE',
  'APPLICATION_COOLDOWN',
  'APPLICATION_FORBIDDEN',
  'APPLICATION_NOT_APPLICABLE',
  // S71 (D13 / FR-W07·W08·W09): 워크스페이스 온보딩(규칙 동의·관심사·웰컴).
  //   RULES_NOT_ACCEPTED:           규칙 존재 + 미동의 채 메시지 전송·리액션 시도 → 403(서버 게이트).
  //   ONBOARDING_RULES_LIMIT:       규칙 10개 초과 생성 → 409.
  //   ONBOARDING_QUESTIONS_LIMIT:   관심사 질문 5개 초과 생성 → 409.
  //   ONBOARDING_RULE_NOT_FOUND:    수정/삭제/재정렬 대상 규칙 미존재 → 404.
  //   ONBOARDING_QUESTION_NOT_FOUND:수정/삭제 대상 질문 미존재 → 404.
  //   ONBOARDING_INVALID_OPTION:    complete 의 선택지 id 가 질문 카탈로그에 없음 → 400.
  'RULES_NOT_ACCEPTED',
  'ONBOARDING_RULES_LIMIT',
  'ONBOARDING_QUESTIONS_LIMIT',
  'ONBOARDING_RULE_NOT_FOUND',
  'ONBOARDING_QUESTION_NOT_FOUND',
  'ONBOARDING_INVALID_OPTION',
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
  // FR-CH-03 (065): 기본 채널(Workspace.defaultChannelId · Channel.isDefault=true)의
  // 삭제/보관 시도 → 409(상태 충돌). 가입자 랜딩 채널은 항상 존재·접근 가능해야 하므로
  // 먼저 다른 채널을 기본으로 지정한 뒤에만 삭제/보관할 수 있다. FE 는 이 코드를 받으면
  // "기본 채널은 삭제/보관할 수 없습니다" 안내로 분기한다(일반 FORBIDDEN 과 구분).
  'DEFAULT_CHANNEL_PROTECTED',
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
  // S54 (D11 / FR-AM-03/04/05/06/27): 첨부 업로드 세션 + 교차검증 + rate-limit.
  'ATTACHMENT_SESSION_NOT_FOUND', // → 404
  'ATTACHMENT_SESSION_EXPIRED', // → 410
  'ATTACHMENT_EXTENSION_BLOCKED', // → 400
  'ATTACHMENT_COUNT_EXCEEDED', // → 400
  'MIME_MISMATCH', // → 400
  'UPLOAD_RATE_LIMIT', // → 429
  // S55 (D11 / FR-CH-18): 채널 첨부 업로드 비활성(fileUploadEnabled=false) → 403.
  'FILE_UPLOAD_DISABLED', // → 403
  // S48 (FR-MN-10): 키워드 알림 등록 한도(25개) 초과 → 400.
  'KEYWORD_LIMIT_EXCEEDED',
  // S51 (FR-PS-07): 개인 저장함 항목 수 한도(500) 초과 → 422.
  'SAVED_LIMIT_EXCEEDED',
  // S52 (FR-PS-08): PATCH 대상 저장 항목이 본인 소유가 아니거나 없음 → 404.
  'SAVED_NOT_FOUND',
  // S80 (D15 / FR-SC-04·05·06): 슬래시 커맨드 실행.
  //   SLASH_COMMAND_UNKNOWN: command 가 BUILTIN_COMMANDS/커스텀 어디에도 없음 → 404.
  //   SLASH_COMMAND_NOT_EXECUTABLE: 실행 핸들러 미구현 커맨드(예: /giphy·커스텀 — S81+) → 422.
  //   REMINDER_PARSE_FAILED: /remind 자연어 시각 파싱 실패(과거/모호/미인식) → 400 + 구문 예시.
  //   REMINDER_NOT_FOUND: DELETE 대상 리마인더가 본인 소유가 아니거나 없음 → 404.
  'SLASH_COMMAND_UNKNOWN',
  'SLASH_COMMAND_NOT_EXECUTABLE',
  'REMINDER_PARSE_FAILED',
  'REMINDER_NOT_FOUND',
  // S81b (D15 / FR-SC-07): /giphy 프록시 불가(env 미설정 / GIPHY 오류·타임아웃 / 형식 위반)
  //   → 503(graceful·ENCRYPTION_UNAVAILABLE 선례). 결과 0건은 EPHEMERAL 안내로 분기(이 코드 아님).
  'GIPHY_UNAVAILABLE',
  // S81c (D15 / FR-SC-09·10): 워크스페이스 커스텀 슬래시 커맨드 CRUD.
  //   SLASH_COMMAND_BUILTIN_CONFLICT: 등록/수정하려는 name 이 빌트인 커맨드명과 충돌(override 금지) → 409.
  //   SLASH_COMMAND_DUPLICATE:        워크스페이스 내 동일 name 커스텀이 이미 존재(@@unique P2002 흡수) → 409.
  //   SLASH_COMMAND_NOT_FOUND:        PATCH/DELETE 대상 커스텀이 본 워크스페이스에 없음(빌트인은 DB 행 없어 404) → 404.
  'SLASH_COMMAND_BUILTIN_CONFLICT',
  'SLASH_COMMAND_DUPLICATE',
  'SLASH_COMMAND_NOT_FOUND',
  // S73 (D14 / FR-PS-01/02/03): 전역 프로필 + 아바타.
  //   HANDLE_TAKEN:           핸들이 이미 점유됨(다른 사용자 @unique) → 409.
  //   HANDLE_COOLDOWN_ACTIVE: 핸들 변경 쿨다운(30일) 미경과 → 400 + details.nextAllowedAt(ISO).
  //   FILE_TOO_LARGE:         아바타 선언/실측 크기 8MB 초과 → 413.
  //   INVALID_MIME:           아바타 MIME 화이트리스트(png/jpeg/webp) 밖 → 415.
  'HANDLE_TAKEN',
  'HANDLE_COOLDOWN_ACTIVE',
  'FILE_TOO_LARGE',
  'INVALID_MIME',
  // S77b (D14 / FR-PS-15·20): 보안(자격증명 변경·TOTP 2FA·세션 관리).
  //   PASSWORD_INCORRECT:      현재 비밀번호 재확인 실패(비번/이메일 변경·2FA 해제) → 403.
  //   TOTP_CODE_REQUIRED:      2FA 해제 시 TOTP 코드 누락 → 403(비번만으론 해제 불가).
  //   TOTP_INVALID:            제출한 6자리 TOTP 코드가 시크릿과 불일치 → 403.
  //   TOTP_ALREADY_ENABLED:    이미 2FA 활성 상태에서 setup/verify 재시도 → 409.
  //   TOTP_NOT_ENABLED:        2FA 미활성 상태에서 해제(disable) 시도 → 409.
  //   SESSION_NOT_FOUND:       로그아웃 대상 세션(RefreshToken)이 본인 소유 아니거나 없음 → 404.
  //   ENCRYPTION_UNAVAILABLE:  APP_ENCRYPTION_KEY 미설정 → 2FA 엔드포인트 graceful 503(크래시 금지).
  'PASSWORD_INCORRECT',
  'TOTP_CODE_REQUIRED',
  'TOTP_INVALID',
  'TOTP_ALREADY_ENABLED',
  'TOTP_NOT_ENABLED',
  'SESSION_NOT_FOUND',
  'ENCRYPTION_UNAVAILABLE',
  // S77c (D14 / FR-PS-16·19): 계정 비활성화/재활성화.
  //   ACCOUNT_DEACTIVATED:     비활성 계정의 로그인/인증 요청 → 403(로그인 시엔 복구 CTA 분기).
  //   ACCOUNT_NOT_DEACTIVATED: 활성 계정에서 reactivate 시도(상태 충돌) → 409.
  'ACCOUNT_DEACTIVATED',
  'ACCOUNT_NOT_DEACTIVATED',
  // S84a (D16 / FR-RC11): 인커밍 웹훅 / 봇 메시지.
  //   WEBHOOK_NOT_FOUND:     관리/회전/삭제 대상 웹훅 미존재(또는 타 워크스페이스) → 404.
  //   WEBHOOK_REVOKED:       폐기/회전된 토큰으로의 인커밍 POST → 403.
  //   WEBHOOK_INVALID_TOKEN: 토큰 미일치/형식오류 인커밍 POST → 403(존재 노출 회피).
  //   WEBHOOK_NAME_RESERVED: username/botDisplayName 예약어(system/qufox/admin) → 422.
  'WEBHOOK_NOT_FOUND',
  'WEBHOOK_REVOKED',
  'WEBHOOK_INVALID_TOKEN',
  'WEBHOOK_NAME_RESERVED',
  // S85 (FR-CH-16): 사이드바 개인 섹션.
  //   SIDEBAR_SECTION_NOT_FOUND:    조회/수정/삭제/재정렬 대상 섹션 또는 anchor 가 본인
  //                                 소유가 아니거나 없음 → 404(중립 — 존재 누출 방지).
  //   SIDEBAR_ASSIGNMENT_NOT_FOUND: 재정렬/해제 대상 채널 할당이 본인 섹션에 없음 → 404.
  'SIDEBAR_SECTION_NOT_FOUND',
  'SIDEBAR_ASSIGNMENT_NOT_FOUND',
  // S86 (FR-MN-15): Web Push(VAPID).
  //   PUSH_SUBSCRIPTION_INVALID: 구독 등록 요청(endpoint/keys) 형식 오류 → 400.
  'PUSH_SUBSCRIPTION_INVALID',
  // FR-RM10a (063): AutoMod 키워드 규칙(BLOCK/TIMEOUT)에 의해 메시지 전송/편집이
  //   차단됨 → 422(요청 envelope 은 well-formed 이나 도메인 모더레이션 규칙 위반).
  'AUTOMOD_BLOCKED',
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
// S68 (D13 / FR-W04·W04a·W18): 이메일 직접 초대 + 보류 초대 관리 컨트랙트.
export * from './email-invite';
// S61 (D12 / FR-RM01·02): 커스텀 Role 시스템 스키마/DTO/시스템역할 정의.
export * from './roles';
// S63 (D12 / FR-RM05·06·07): 모더레이션(Kick/Ban/Timeout) 스키마·DTO·상수.
// S64 (D12 / FR-RM09·11): bulk purge + 신고 큐 스키마·DTO·상수도 같은 파일에 합류.
export * from './moderation';
// S64 (D12 / FR-RM12): 감사 로그 조회(cursor 페이지네이션·필터) 스키마·DTO.
export * from './audit';
// FR-RM10a (063): AutoMod 키워드 모더레이션 규칙 스키마·DTO·상수.
export * from './automod';
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
// S73 — 전역 프로필 + 아바타 컨트랙트 (D14 / FR-PS-01·02·03)
export * from './profile';
// S54 — 첨부 업로드 세션 + 차단확장자 + MIME 화이트리스트 + 읽음 모드 (D11 / FR-AM-03~06/27 + FR-RS-13)
export * from './attachment';
// S60 — 링크 unfurl 계약 + URL 정규화 (D11 / FR-RC07/08/09/21 + FR-AM-13~16)
export * from './links';
// S70 — 가입 신청(APPLY 모드) 컨트랙트 (D13 / FR-W06·W06a·W12)
export * from './member-application';
// S71 — 워크스페이스 온보딩 컨트랙트 (D13 / FR-W07·W08·W09·W09a)
export * from './onboarding';
// S76 — 외관 설정 컨트랙트 (D14 / FR-PS-09 + FR-PS-18)
export * from './settings';
// S77b — 보안 컨트랙트(자격증명 변경·TOTP 2FA·세션 관리) (D14 / FR-PS-15·20)
export * from './security';
// S79 — 슬래시 커맨드 자동완성 컨트랙트 (D15 / FR-SC-01·02·03)
export * from './slash-command';
// S80 — 슬래시 커맨드 실행 + Reminder 컨트랙트 (D15 / FR-SC-04·05·06 + FR-RC18)
export * from './slash-execution';

export * from './webhook';

// S84b — 봇/웹훅 rich embed 배열 (D16 / FR-RC12)
export * from './rich-embed';

// S85 — 사이드바 개인 섹션 컨트랙트 (FR-CH-16)
export * from './sidebar-section';

// S86 — Web Push(VAPID) 구독 + 공개키 컨트랙트 (FR-MN-15)
export * from './push';

// S87 — push 구독 device 분류(ua → mobile/desktop) 순수 함수 (FR-MN-18)
export * from './push-device';
