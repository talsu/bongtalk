export enum ErrorCode {
  AUTH_INVALID_TOKEN = 'AUTH_INVALID_TOKEN',
  AUTH_EMAIL_TAKEN = 'AUTH_EMAIL_TAKEN',
  AUTH_USERNAME_TAKEN = 'AUTH_USERNAME_TAKEN',
  AUTH_WEAK_PASSWORD = 'AUTH_WEAK_PASSWORD',
  AUTH_INVALID_CREDENTIALS = 'AUTH_INVALID_CREDENTIALS',
  AUTH_ACCOUNT_LOCKED = 'AUTH_ACCOUNT_LOCKED',
  AUTH_SESSION_COMPROMISED = 'AUTH_SESSION_COMPROMISED',

  // S66 (D13 / FR-W05a): emailVerified=false 사용자의 워크스페이스 진입(JOIN·ACCEPT·
  // DOMAIN_JOIN) 및 채널 메시지 전송을 차단 → 403. "가입/초대 수락/채널 진입 시점에
  // emailVerified 재확인"이라는 PRD 불변식의 단일 거부 코드다.
  EMAIL_NOT_VERIFIED = 'EMAIL_NOT_VERIFIED',
  // S66 (D13 / FR-W05a): 워크스페이스 emailDomains 화이트리스트(exact match) 불일치 →
  // 403. user.email.split('@')[1] === domain(소문자 정규화). 빈 배열이면 제한 없음.
  WORKSPACE_DOMAIN_NOT_ALLOWED = 'WORKSPACE_DOMAIN_NOT_ALLOWED',
  // S66 (D13 / FR-W05b): 인증 메일 재발송 쿨다운(60s)/일일한도(5회) 초과 → 429.
  EMAIL_VERIFICATION_RATE_LIMITED = 'EMAIL_VERIFICATION_RATE_LIMITED',
  // S66 (D13 / FR-W05b): 인증 토큰 만료(발급 24h 경과) → 410(자원이 한때 유효했으나 소멸).
  EMAIL_VERIFICATION_TOKEN_EXPIRED = 'EMAIL_VERIFICATION_TOKEN_EXPIRED',
  // S66 (D13 / FR-W05b): 인증 토큰 미존재/형식오류/이미 사용됨(usedAt) → 400.
  EMAIL_VERIFICATION_TOKEN_INVALID = 'EMAIL_VERIFICATION_TOKEN_INVALID',

  WORKSPACE_NOT_FOUND = 'WORKSPACE_NOT_FOUND',
  WORKSPACE_NOT_MEMBER = 'WORKSPACE_NOT_MEMBER',
  WORKSPACE_SLUG_TAKEN = 'WORKSPACE_SLUG_TAKEN',
  WORKSPACE_SLUG_RESERVED = 'WORKSPACE_SLUG_RESERVED',
  WORKSPACE_INSUFFICIENT_ROLE = 'WORKSPACE_INSUFFICIENT_ROLE',
  WORKSPACE_CANNOT_DEMOTE_OWNER = 'WORKSPACE_CANNOT_DEMOTE_OWNER',
  WORKSPACE_CANNOT_REMOVE_OWNER = 'WORKSPACE_CANNOT_REMOVE_OWNER',
  WORKSPACE_OWNER_MUST_TRANSFER = 'WORKSPACE_OWNER_MUST_TRANSFER',
  WORKSPACE_TARGET_NOT_MEMBER = 'WORKSPACE_TARGET_NOT_MEMBER',
  WORKSPACE_ALREADY_MEMBER = 'WORKSPACE_ALREADY_MEMBER',
  WORKSPACE_PURGED = 'WORKSPACE_PURGED',
  WORKSPACE_NOT_PUBLIC = 'WORKSPACE_NOT_PUBLIC',
  // S65 (D13 / FR-W19): 기본 채널 변경 대상이 비공개 채널이면 거부한다(가입자
  // 랜딩 채널은 모두가 접근 가능한 공개 채널이어야 한다).
  WORKSPACE_DEFAULT_CHANNEL_NOT_PUBLIC = 'WORKSPACE_DEFAULT_CHANNEL_NOT_PUBLIC',
  // S65 fix-forward (security A-2): joinMode=APPLY(신청 후 승인) 워크스페이스에
  // 즉시 가입(POST /join)을 시도 → 409. 신청 플로우(FR-W06)는 S66 carryover 라
  // 아직 미지원이며, 그 전까지 즉시 가입으로 우회되면 승인 게이트가 무력화되므로
  // 명시적으로 거부한다(visibility=PUBLIC 이라도 joinMode=APPLY 면 막힌다).
  WORKSPACE_APPLY_NOT_SUPPORTED = 'WORKSPACE_APPLY_NOT_SUPPORTED',
  // S65 fix-forward (D-2): PUBLIC 전환 시 category/description 누락 → 422. 요청
  // envelope 자체는 well-formed(UpdateWorkspaceRequestSchema 통과)이나, "공개 워크
  // 스페이스는 카테고리+설명 필수"라는 도메인 불변식을 못 넘긴 처리 불가 상태다.
  // 종전 VALIDATION_FAILED(400, shape 오류 전용)에서 분리 — discover 정합성 게이트라
  // WORKSPACE_DEFAULT_CHANNEL_NOT_PUBLIC(422)와 같은 계열로 둔다.
  WORKSPACE_PUBLIC_REQUIRES_METADATA = 'WORKSPACE_PUBLIC_REQUIRES_METADATA',
  // S72 (D13 / FR-W15): 워크스페이스 삭제 confirmation 불일치(body.confirmation !==
  // workspace.slug) → 422. 요청 envelope 은 well-formed(DeleteWorkspaceRequestSchema
  // 통과 — confirmation 은 string)이나, "삭제하려면 slug 를 정확히 타이핑"이라는 파괴적
  // 액션 게이트를 못 넘긴 처리 불가 상태다. 채널 비공개→공개 confirmName(CHANNEL_CONFIRM_
  // REQUIRED) 선례와 같은 계열이지만, 워크스페이스 삭제는 30일 후 영구 삭제로 비가역적이라
  // 422(처리 불가 — 도메인 불변식)로 둔다(WORKSPACE_PUBLIC_REQUIRES_METADATA 와 동일 매핑).
  WORKSPACE_CONFIRMATION_MISMATCH = 'WORKSPACE_CONFIRMATION_MISMATCH',

  // S61 (D12 / FR-RM01·04·15): 커스텀 Role 시스템.
  ROLE_NOT_FOUND = 'ROLE_NOT_FOUND',
  ROLE_NAME_TAKEN = 'ROLE_NAME_TAKEN',
  ROLE_SYSTEM_IMMUTABLE = 'ROLE_SYSTEM_IMMUTABLE',
  ROLE_PRIVILEGE_ESCALATION = 'ROLE_PRIVILEGE_ESCALATION',
  ROLE_POSITION_TOO_HIGH = 'ROLE_POSITION_TOO_HIGH',
  ROLE_INVALID_PERMISSIONS = 'ROLE_INVALID_PERMISSIONS',

  // S63 (D12 / FR-RM05·06·07): 모더레이션(Kick/Ban/Timeout).
  // 대상이 actor 보다 상위 역할 position → 403(계층 방어, S61 precedent 재사용).
  MODERATION_TARGET_HIGHER = 'MODERATION_TARGET_HIGHER',
  // 자기 자신을 kick/ban/timeout 대상으로 지정 → 400.
  MODERATION_CANNOT_SELF = 'MODERATION_CANNOT_SELF',
  // 이미 차단된 userId 를 재차 ban → 409(상태 충돌).
  MEMBER_ALREADY_BANNED = 'MEMBER_ALREADY_BANNED',
  // unban 대상이 차단 목록에 없음 → 404.
  MEMBER_NOT_BANNED = 'MEMBER_NOT_BANNED',
  // 타임아웃 중(mutedUntil>now) 메시지/반응/슬래시 시도 → 403.
  MEMBER_TIMED_OUT = 'MEMBER_TIMED_OUT',
  // kick undo 토큰 만료/무효/이미 사용/재가입됨 → 409.
  KICK_UNDO_INVALID = 'KICK_UNDO_INVALID',

  // S64 (D12 / FR-RM09): bulk purge 선택 메시지 개수가 상한(200) 초과 → 400.
  BULK_DELETE_LIMIT = 'BULK_DELETE_LIMIT',
  // S64 (D12 / FR-RM11): 같은 메시지를 같은 신고자가 중복 신고 → 409(@@unique 충돌).
  REPORT_DUPLICATE = 'REPORT_DUPLICATE',
  // S64 (D12 / FR-RM11): 처리 대상 신고가 없음 → 404.
  REPORT_NOT_FOUND = 'REPORT_NOT_FOUND',
  // S64 (D12 / FR-RM11): 이미 처리된 신고를 재처리 → 409(상태 충돌).
  REPORT_ALREADY_RESOLVED = 'REPORT_ALREADY_RESOLVED',

  FRIEND_TARGET_NOT_FOUND = 'FRIEND_TARGET_NOT_FOUND',
  FRIEND_CANNOT_SELF = 'FRIEND_CANNOT_SELF',
  FRIEND_ALREADY = 'FRIEND_ALREADY',
  FRIEND_BLOCKED = 'FRIEND_BLOCKED',
  FRIEND_REQUEST_DUPLICATE = 'FRIEND_REQUEST_DUPLICATE',
  FRIEND_NOT_FOUND = 'FRIEND_NOT_FOUND',
  FRIEND_INVALID_STATE = 'FRIEND_INVALID_STATE',
  FRIEND_CAP_REACHED = 'FRIEND_CAP_REACHED',
  // S77a (FR-PS-13): 대상의 친구 요청 수신 정책(allowFriendRequests)을 충족하지 못해
  // 친구 요청 생성이 거부됨(NOBODY 거부 / MUTUAL_WORKSPACE 공통 워크스페이스 부재). 권한
  // 거부라 403 으로 매핑한다(FRIEND_TARGET_NOT_FOUND 404 와 구분).
  FRIEND_REQUEST_BLOCKED = 'FRIEND_REQUEST_BLOCKED',

  // S16 (FR-DM-02): 그룹 DM 구성원 수 상한(본인 포함 ≤20) 초과. 요청 자체는
  // 형식상 유효하지만 도메인 한도를 넘어 처리 불가 → 422 (Unprocessable Entity).
  DM_GROUP_CAP_EXCEEDED = 'DM_GROUP_CAP_EXCEEDED',
  // S19 (FR-DM-12): 대상의 DM 수신권한(allowDmFrom=WORKSPACE_MEMBER)을 충족하지
  // 못해 DM 개시/멤버 추가가 거부됨(공통 워크스페이스 멤버도 ACCEPTED 친구도 아님).
  // 비노출 정책(H-03): friend-gate(FRIEND_NOT_FOUND) 와 동일한 중립 메시지를 쓰되
  // 권한 거부는 403 으로 분리해 클라이언트가 "DM 수신 차단됨" UI 로 분기할 수 있게 한다.
  DM_PRIVACY_RESTRICTED = 'DM_PRIVACY_RESTRICTED',

  INVITE_NOT_FOUND = 'INVITE_NOT_FOUND',
  INVITE_EXPIRED = 'INVITE_EXPIRED',
  INVITE_EXHAUSTED = 'INVITE_EXHAUSTED',
  INVITE_REVOKED = 'INVITE_REVOKED',
  BETA_INVITE_REQUIRED = 'BETA_INVITE_REQUIRED',

  // S68 (D13 / FR-W04·W04a): 이메일 직접 초대.
  // 토큰(또는 opaque 코드) 미존재/형식오류/이미 취소됨 → 400. ★핵심 AC: sha256 대조
  // 실패도 미존재와 동일하게 INVALID 로 거부(열거 누출 방지).
  EMAIL_INVITE_TOKEN_INVALID = 'EMAIL_INVITE_TOKEN_INVALID',
  // 초대(또는 opaque 교환 코드) 만료(발급 30일/opaque 10분 경과) → 410(한때 유효했으나 소멸).
  EMAIL_INVITE_EXPIRED = 'EMAIL_INVITE_EXPIRED',
  // 수락 시 token role ↔ DB role 대조 불일치 → 400(위조/변조 방어).
  EMAIL_INVITE_ROLE_MISMATCH = 'EMAIL_INVITE_ROLE_MISMATCH',
  // S68 fix-forward (reviewer B1): 수락 actor 의 이메일이 초대 대상 이메일과 불일치 →
  // 403. FR-W04a 분기③(다른 계정) 의도를 서버가 강제한다 — 가입 시 이메일 변경(opaque
  // 경로)이나 다른 계정 로그인(rawToken 경로)으로 초대 대상이 아닌 계정이 수락하는 것을
  // 막는다(normalizeEmail(actor.userEmail) === pending.email). FE 가 이 코드를 받으면
  // "초대받은 이메일로 로그인" 안내(분기③)로 분기한다.
  EMAIL_INVITE_EMAIL_MISMATCH = 'EMAIL_INVITE_EMAIL_MISMATCH',
  // 이미 수락된 보류 초대를 재차 수락 → 409(상태 충돌).
  EMAIL_INVITE_ALREADY_ACCEPTED = 'EMAIL_INVITE_ALREADY_ACCEPTED',
  // 보류 초대(관리 대상)가 없음(연장/재발송/취소 대상 미존재) → 404.
  EMAIL_INVITE_NOT_FOUND = 'EMAIL_INVITE_NOT_FOUND',
  // S68 (D13 / FR-W05): emailDomains 화이트리스트 변경(PATCH)은 OWNER 전용 → 403.
  // 서비스 레이어 게이트(visibility/category OWNER 게이트 선례 일관).
  WORKSPACE_EMAIL_DOMAINS_FORBIDDEN = 'WORKSPACE_EMAIL_DOMAINS_FORBIDDEN',

  // S70 (D13 / FR-W06·W06a): 가입 신청(APPLY 모드) 플로우.
  // 이미 PENDING 신청이 존재하는데 다시 제출 → 409(상태 충돌 — 중복 신청 금지).
  APPLICATION_PENDING_EXISTS = 'APPLICATION_PENDING_EXISTS',
  // 처리/취소 대상 신청이 없음(타인 신청·삭제·잘못된 id) → 404(중립 — 존재 누출 방지).
  APPLICATION_NOT_FOUND = 'APPLICATION_NOT_FOUND',
  // 상태 전이가 불가(PENDING/INTERVIEW 아닌 신청 처리·PENDING 아닌 신청 취소) → 409.
  APPLICATION_INVALID_STATE = 'APPLICATION_INVALID_STATE',
  // REJECTED 후 24h 쿨다운 내 재신청 → 429(rate-limit 계열) + retryAfterMs(details).
  APPLICATION_COOLDOWN = 'APPLICATION_COOLDOWN',
  // approve/interview 를 ADMIN 미만(MODERATOR)이 시도 → 403(MODERATOR 는 reject 만).
  APPLICATION_FORBIDDEN = 'APPLICATION_FORBIDDEN',
  // joinMode 가 APPLY 가 아닌 워크스페이스에 신청 제출 → 409(신청 비대상 — PUBLIC/PRIVATE).
  APPLICATION_NOT_APPLICABLE = 'APPLICATION_NOT_APPLICABLE',

  // S71 (D13 / FR-W07·W08·W09): 워크스페이스 온보딩(규칙 동의·관심사·웰컴).
  // RULES_NOT_ACCEPTED: 워크스페이스에 규칙이 존재하는데 멤버가 아직 동의하지 않은 채
  //   메시지 전송·리액션 추가를 시도 → 403(서버 게이트 — FE 오버레이만으론 불충분, Fork-C).
  RULES_NOT_ACCEPTED = 'RULES_NOT_ACCEPTED',
  // ONBOARDING_RULES_LIMIT: 규칙 최대 10개 초과 생성 → 409(상태 충돌).
  ONBOARDING_RULES_LIMIT = 'ONBOARDING_RULES_LIMIT',
  // ONBOARDING_QUESTIONS_LIMIT: 관심사 질문 최대 5개 초과 생성 → 409(상태 충돌).
  ONBOARDING_QUESTIONS_LIMIT = 'ONBOARDING_QUESTIONS_LIMIT',
  // ONBOARDING_RULE_NOT_FOUND: 수정/삭제/재정렬 대상 규칙 미존재(또는 타 워크스페이스) → 404.
  ONBOARDING_RULE_NOT_FOUND = 'ONBOARDING_RULE_NOT_FOUND',
  // ONBOARDING_QUESTION_NOT_FOUND: 수정/삭제 대상 질문 미존재(또는 타 워크스페이스) → 404.
  ONBOARDING_QUESTION_NOT_FOUND = 'ONBOARDING_QUESTION_NOT_FOUND',
  // ONBOARDING_INVALID_OPTION: complete 요청의 선택지 id 가 질문 카탈로그에 없음 → 400.
  ONBOARDING_INVALID_OPTION = 'ONBOARDING_INVALID_OPTION',

  CHANNEL_NOT_FOUND = 'CHANNEL_NOT_FOUND',
  CHANNEL_NAME_TAKEN = 'CHANNEL_NAME_TAKEN',
  CHANNEL_NAME_INVALID = 'CHANNEL_NAME_INVALID',
  CHANNEL_TYPE_NOT_IMPLEMENTED = 'CHANNEL_TYPE_NOT_IMPLEMENTED',
  CHANNEL_PURGED = 'CHANNEL_PURGED',
  CHANNEL_POSITION_INVALID = 'CHANNEL_POSITION_INVALID',
  CHANNEL_ARCHIVED = 'CHANNEL_ARCHIVED',
  // S13 (FR-CH-19): ANNOUNCEMENT 채널에서 게시 권한(SEND_MESSAGES /
  // WRITE_MESSAGE 비트) 없는 역할이 메시지를 POST → 403. 일반 권한 부족
  // (FORBIDDEN) 과 구분해 프론트가 "공지 채널 게시 제한" UI 를 띄울 수 있게 한다.
  CHANNEL_POSTING_RESTRICTED = 'CHANNEL_POSTING_RESTRICTED',
  // S14 (FR-CH-05): 비공개→공개 전환 시 confirmName(채널 이름) 누락/불일치.
  // 파괴적·되돌릴 수 없는 변경이므로 전용 코드로 분리해 클라이언트가
  // "이름 재입력" UI 를 띄울 수 있게 한다. → 400.
  CHANNEL_CONFIRM_REQUIRED = 'CHANNEL_CONFIRM_REQUIRED',
  // S14 (FR-CH-07): 비공개 채널은 초대 기반 가입만 허용 — 자유 가입 시도 거부. → 403.
  CHANNEL_PRIVATE_INVITE_ONLY = 'CHANNEL_PRIVATE_INVITE_ONLY',
  // S14 (FR-CH-07): 채널 멤버가 아닌데 탈퇴 시도. → 409.
  CHANNEL_NOT_MEMBER = 'CHANNEL_NOT_MEMBER',
  // S15 (FR-CH-08): 슬로우모드 활성 중 잔여 시간 내 재송신. → 429 + retry-after.
  // retryAfterMs(details) 로 잔여 밀리초를 실어보내 클라이언트가 카운트다운을
  // 띄울 수 있게 한다. BYPASS_SLOWMODE 비트 보유자는 이 게이트를 우회한다.
  CHANNEL_SLOWMODE_ACTIVE = 'CHANNEL_SLOWMODE_ACTIVE',
  CATEGORY_NOT_FOUND = 'CATEGORY_NOT_FOUND',
  CATEGORY_NAME_TAKEN = 'CATEGORY_NAME_TAKEN',
  // S43 (FR-CH-15): 즐겨찾기 재정렬 anchor 가 가리키는 즐겨찾기 행이 없음
  // (해제됐거나 타인 소유). → 404.
  FAVORITE_NOT_FOUND = 'FAVORITE_NOT_FOUND',

  MESSAGE_NOT_FOUND = 'MESSAGE_NOT_FOUND',
  MESSAGE_CONTENT_INVALID = 'MESSAGE_CONTENT_INVALID',
  MESSAGE_CURSOR_INVALID = 'MESSAGE_CURSOR_INVALID',
  // S02 (FR-MSG-03 / FR-MSG-20): contentPlain 4,000자 초과.
  MESSAGE_TOO_LONG = 'MESSAGE_TOO_LONG',
  // S00 carryover (FR-MSG-23): mrkdwn 파서 ReDoS 방어 한도. 모두 400.
  // 한도는 shared-types MRKDWN_PARSE_LIMITS, throw 는 MrkdwnParseError.
  PARSE_TIMEOUT = 'PARSE_TIMEOUT',
  PARSE_DEPTH_EXCEEDED = 'PARSE_DEPTH_EXCEEDED',
  PARSE_NODE_LIMIT = 'PARSE_NODE_LIMIT',
  PARSE_AST_TOO_LARGE = 'PARSE_AST_TOO_LARGE',
  MESSAGE_NOT_AUTHOR = 'MESSAGE_NOT_AUTHOR',
  MESSAGE_THREAD_DEPTH_EXCEEDED = 'MESSAGE_THREAD_DEPTH_EXCEEDED',
  MESSAGE_PARENT_NOT_FOUND = 'MESSAGE_PARENT_NOT_FOUND',
  // S38 (FR-TH-13): 잠긴 스레드에 MEMBER 이하가 답글 시도 → 403. OWNER/ADMIN 면제.
  THREAD_LOCKED = 'THREAD_LOCKED',
  // task-044-iter2 / S50 (D10 · FR-PS-04): pinned messages hard cap(55/channel)
  // 초과. soft cap 은 50(클라 경고 toast), hard cap 55 초과 시도만 거부 → 423 Locked.
  MESSAGE_PIN_CAP_EXCEEDED = 'MESSAGE_PIN_CAP_EXCEEDED',
  // S05 (FR-MSG-06): 편집 낙관적 잠금 충돌. expectedVersion ≠ 현재 version
  // → 409. 필터가 details.current(현재 MessageDto)를 응답 body 에 실어
  // 클라이언트가 편집창을 서버 최신값으로 롤백할 수 있게 합니다.
  MESSAGE_VERSION_CONFLICT = 'MESSAGE_VERSION_CONFLICT',
  IDEMPOTENCY_KEY_REUSE_CONFLICT = 'IDEMPOTENCY_KEY_REUSE_CONFLICT',

  // S39 (FR-RE02 / D05): 메시지당 고유 이모지 반응 종류 한도(20) 초과. INSERT 후
  // 단일 tx 내 COUNT … FOR UPDATE 로 20 초과를 감지하면 방금 삽입한 행을 DELETE 한
  // 뒤 이 코드로 거부한다(D12 FR-RM16 동시성 패턴). 이미 존재하는 이모지를 토글
  // 추가하는 것은 신규 종류가 아니라 한도와 무관하다. → 409 (상태 충돌 계열).
  REACTION_LIMIT_REACHED = 'REACTION_LIMIT_REACHED',

  // task-012-B attachments + task-012-D channel ACL
  ATTACHMENT_NOT_FOUND = 'ATTACHMENT_NOT_FOUND',
  ATTACHMENT_TOO_LARGE = 'ATTACHMENT_TOO_LARGE',
  ATTACHMENT_MIME_REJECTED = 'ATTACHMENT_MIME_REJECTED',
  ATTACHMENT_NOT_UPLOADED = 'ATTACHMENT_NOT_UPLOADED',
  ATTACHMENT_SIZE_MISMATCH = 'ATTACHMENT_SIZE_MISMATCH',
  CHANNEL_NOT_VISIBLE = 'CHANNEL_NOT_VISIBLE',

  // task-037-D custom emoji
  CUSTOM_EMOJI_NOT_FOUND = 'CUSTOM_EMOJI_NOT_FOUND',
  CUSTOM_EMOJI_NAME_TAKEN = 'CUSTOM_EMOJI_NAME_TAKEN',
  CUSTOM_EMOJI_NAME_INVALID = 'CUSTOM_EMOJI_NAME_INVALID',
  // S41 (FR-EM02): 워크스페이스당 커스텀 이모지 100개 한도 초과. PRD 정본은 이
  // 거부를 409 + { errorCode: EMOJI_WORKSPACE_LIMIT } 로 명시한다(종전 task-037-D
  // 의 CUSTOM_EMOJI_CAP_REACHED 422 를 정합 — INSERT ON CONFLICT DO NOTHING 후
  // 단일 tx 내 COUNT … FOR UPDATE 로 100 초과 시 방금 삽입행 DELETE 후 이 코드로
  // 거부). 상태 충돌 계열이므로 409 가 422 보다 정확하다.
  EMOJI_WORKSPACE_LIMIT = 'EMOJI_WORKSPACE_LIMIT',
  // S41 (FR-EM01 / FR-RC20): 업로드 파일이 MIME 화이트리스트(png/gif/webp) 밖이거나
  // size 한도(256KB)를 벗어남. PRD 정본은 이 거부를 422 INVALID_FILE 로 명시한다
  // (종전 CUSTOM_EMOJI_MIME_REJECTED 415 / CUSTOM_EMOJI_TOO_LARGE 413 를 정합 —
  // 요청 envelope 은 well-formed JSON 이나 선언된 파일이 도메인 제약을 못 넘김).
  INVALID_FILE = 'INVALID_FILE',

  // S42 (FR-EM05): 커스텀 이모지 별칭 한도(이모지당 10개) 초과. PRD 정본은 이
  // 거부를 409 로 명시한다(상태 충돌 계열 — 한도가 찬 상태에서의 추가 거부).
  ALIAS_LIMIT = 'ALIAS_LIMIT',
  // S42 (FR-EM05): 별칭이 워크스페이스 내 다른 별칭 또는 CustomEmoji.name 과
  // 충돌. PRD 정본은 이 거부를 409 로 명시한다(상태 충돌 — 이미 점유된 슬러그).
  ALIAS_CONFLICT = 'ALIAS_CONFLICT',

  // task-038-B magic-byte mismatch between declared mime and actual
  // file prefix. 400 so the client surfaces it as a validation error
  // (not a content-type 415 — the client DID send a valid mime, it
  // just doesn't match what they actually uploaded).
  INVALID_MAGIC_BYTES = 'INVALID_MAGIC_BYTES',

  // S54 (D11 / FR-AM-03): complete 단계에서 참조한 업로드 세션이 없음(타인 소유·삭제·
  // 잘못된 sessionId) → 404. 존재 자체를 누출하지 않도록 중립 404.
  ATTACHMENT_SESSION_NOT_FOUND = 'ATTACHMENT_SESSION_NOT_FOUND',
  // S54 (D11 / FR-AM-03): 업로드 세션 만료(expiresAt < now). presigned PUT/POST 의
  // TTL 이 지나 재발급이 필요함 → 410 Gone(자원이 한때 유효했으나 소멸).
  ATTACHMENT_SESSION_EXPIRED = 'ATTACHMENT_SESSION_EXPIRED',
  // S54 (D11 / FR-AM-05): 차단 확장자(.exe/.dll/.bat …) 업로드 시도 → 400. zip/jar/apk
  // PK 헤더 공유 교차검증 실패도 이 코드 계열로 거부.
  ATTACHMENT_EXTENSION_BLOCKED = 'ATTACHMENT_EXTENSION_BLOCKED',
  // S54 (D11 / FR-AM-04): 메시지당 첨부 개수(10) 초과 → 400. complete 시 신규 세션
  // 길이 + 기존 message.attachments 카운트 합이 10 을 넘으면 거부.
  ATTACHMENT_COUNT_EXCEEDED = 'ATTACHMENT_COUNT_EXCEEDED',
  // S54 (D11 / FR-AM-05/06): 선언 MIME 와 확장자/실제 magic-byte 불일치(zip↔jar 교차,
  // declared image/png 인데 실 바이트가 다른 시그니처 등) → 400. INVALID_MAGIC_BYTES
  // (422, 기존 finalize 경로)와 구분해 complete 경로의 교차검증 실패를 별도 코드로 둔다.
  MIME_MISMATCH = 'MIME_MISMATCH',
  // S54 (D11 / FR-AM-27): upload-url rate limit 초과(15분 60회·1분 10회·동시 미완료
  // 세션 20개 중 하나) → 429. 일반 RATE_LIMITED 와 구분해 클라가 "업로드 한도" 토스트로
  // 분기할 수 있게 별도 코드로 둔다.
  UPLOAD_RATE_LIMIT = 'UPLOAD_RATE_LIMIT',
  // S55 (D11 / FR-CH-18): 채널의 fileUploadEnabled=false 인데 upload-url 을 시도 →
  // 403. 일반 FORBIDDEN(권한 부족)과 구분해 클라가 "이 채널은 첨부가 비활성화됨"
  // 안내를 띄울 수 있게 별도 코드로 둔다.
  FILE_UPLOAD_DISABLED = 'FILE_UPLOAD_DISABLED',

  // S48 (D06 / FR-MN-10): 글로벌 키워드 알림 등록 한도(25개) 초과. PRD 정본은
  // 이 거부를 400 으로 명시한다(서비스 레이어 검증 — 26번째 등록 시도 시 400,
  // 상수 KEYWORD_MAX_COUNT=25). 요청 envelope 은 well-formed 이나 도메인 상한을
  // 넘김 — 다른 검증 실패(VALIDATION_FAILED)와 구별해 클라이언트가 전용 토스트를
  // 띄울 수 있도록 별도 코드로 둔다.
  KEYWORD_LIMIT_EXCEEDED = 'KEYWORD_LIMIT_EXCEEDED',

  // S51 (D10 / FR-PS-07): 개인 저장함 항목 수 한도(SAVED_LIMIT=500) 초과. POST 시
  // 현재 카운트가 500 이상이면 거부 → 422(요청 envelope 은 well-formed 이나 도메인
  // 상한을 넘김). soft·advisory lock 불요라 ±1 drift 는 허용한다.
  SAVED_LIMIT_EXCEEDED = 'SAVED_LIMIT_EXCEEDED',

  // S52 (D10 / FR-PS-08): PATCH /me/saved/:savedMessageId 대상 저장 항목이 호출자
  // 본인 소유가 아니거나 존재하지 않음 → 404. 본인 스코프(id+userId) where 가
  // 일치하지 않으면 존재 자체를 누출하지 않도록 중립적으로 404 로 거부한다.
  SAVED_NOT_FOUND = 'SAVED_NOT_FOUND',

  // S80 (D15 / FR-SC-04·05·06): 슬래시 커맨드 실행.
  //   SLASH_COMMAND_UNKNOWN: command 가 BUILTIN_COMMANDS/커스텀 어디에도 없음 → 404.
  //   SLASH_COMMAND_NOT_EXECUTABLE: 실행 핸들러 미구현 커맨드(/giphy·커스텀 — S81+) → 422.
  //   REMINDER_PARSE_FAILED: /remind 자연어 시각 파싱 실패(과거/모호/미인식) → 400 + 구문 예시.
  //   REMINDER_NOT_FOUND: DELETE 대상 리마인더가 본인 소유가 아니거나 없음 → 404.
  SLASH_COMMAND_UNKNOWN = 'SLASH_COMMAND_UNKNOWN',
  SLASH_COMMAND_NOT_EXECUTABLE = 'SLASH_COMMAND_NOT_EXECUTABLE',
  REMINDER_PARSE_FAILED = 'REMINDER_PARSE_FAILED',
  REMINDER_NOT_FOUND = 'REMINDER_NOT_FOUND',
  // S81b (D15 / FR-SC-07): /giphy 실행 — GIPHY 프록시 불가(GIPHY_API_KEY 미설정 / GIPHY API
  // 오류·타임아웃 / 응답 형식 위반) → 503. ENCRYPTION_UNAVAILABLE(2FA env 미설정 503) 선례와
  // 동일한 graceful "기능 비활성/외부 의존 불가" 신호로, 절대 500/크래시로 떨어지지 않는다.
  // 키워드 결과 0건은 GIPHY 자체는 정상이므로 이 코드가 아니라 EPHEMERAL "결과 없음"으로 분기한다.
  GIPHY_UNAVAILABLE = 'GIPHY_UNAVAILABLE',
  // S81c (D15 / FR-SC-09·10): 워크스페이스 커스텀 슬래시 커맨드 CRUD.
  //   SLASH_COMMAND_BUILTIN_CONFLICT: 등록/수정 name 이 빌트인 커맨드명과 충돌(override 금지) → 409.
  //   SLASH_COMMAND_DUPLICATE:        워크스페이스 내 동일 name 커스텀 이미 존재(@@unique P2002 흡수) → 409.
  //   SLASH_COMMAND_NOT_FOUND:        PATCH/DELETE 대상 커스텀이 본 워크스페이스에 없음(빌트인은 DB 행 없음) → 404.
  SLASH_COMMAND_BUILTIN_CONFLICT = 'SLASH_COMMAND_BUILTIN_CONFLICT',
  SLASH_COMMAND_DUPLICATE = 'SLASH_COMMAND_DUPLICATE',
  SLASH_COMMAND_NOT_FOUND = 'SLASH_COMMAND_NOT_FOUND',
  // S81a (D15 / FR-SC-08): /msg·/invite·/kick·/topic 의 대상 해석/권한 실패는 별도 wire
  // ErrorCode 를 두지 않는다 — execute() 가 모두 발신자 전용 EPHEMERAL error:true 로 흡수해
  // (forbiddenEphemeral·targetNotFoundEphemeral) 채널에 게시하지 않고 인라인 표시하므로,
  // HTTP 로 노출될 코드가 없다(리뷰 fix-forward: 미사용 enum 제거·drift 테스트 정합).

  // S73 (D14 / FR-PS-02): 전역 핸들(handle)은 @unique 라 다른 사용자가 이미 점유한
  // 핸들로 변경 시도 → 409(상태 충돌). DB unique 제약(P2002)을 흡수해 이 코드로 변환한다.
  HANDLE_TAKEN = 'HANDLE_TAKEN',
  // S73 (D14 / FR-PS-03): 핸들 변경 쿨다운(마지막 변경 + 30일) 미경과 상태에서 다시
  // 변경 시도 → 400. 응답 details.nextAllowedAt(ISO)에 다음 변경 가능 시각을 실어
  // 클라이언트가 "다음 변경 가능일 D-N" 을 표시할 수 있게 한다.
  HANDLE_COOLDOWN_ACTIVE = 'HANDLE_COOLDOWN_ACTIVE',
  // S73 (D14 / FR-PS-01): 아바타 업로드 선언 크기가 8MB 한도를 초과 → 413. presign
  // 단계에서 sizeBytes 로, finalize 단계에서 HEAD 실측치로 이중 검증한다.
  FILE_TOO_LARGE = 'FILE_TOO_LARGE',
  // S73 (D14 / FR-PS-01): 아바타 MIME 가 화이트리스트(png/jpeg/webp) 밖 → 415. 선언
  // MIME 거부 전용 코드로, finalize 의 실 바이트 불일치(INVALID_MAGIC_BYTES 422)와 구분한다.
  INVALID_MIME = 'INVALID_MIME',

  // S77b (D14 / FR-PS-15·20): 보안(자격증명 변경·TOTP 2FA·세션 관리).
  //   PASSWORD_INCORRECT: 비번/이메일 변경·2FA 해제 시 현재 비번 재확인 실패 → 403.
  //     AUTH_INVALID_CREDENTIALS(로그인 401)와 구분 — 이미 인증된 세션의 재확인 거부다.
  //   TOTP_CODE_REQUIRED: 2FA 해제 시 비번만 보내고 TOTP 코드를 누락 → 403(비번 단독 해제 차단).
  //   TOTP_INVALID:       제출한 6자리 TOTP 코드가 시크릿과 불일치(verify/disable) → 403.
  //   TOTP_ALREADY_ENABLED: 이미 totpEnabled=true 인데 setup/verify 재시도 → 409(상태 충돌).
  //   TOTP_NOT_ENABLED:   totpEnabled=false 인데 disable 시도 → 409(상태 충돌).
  //   SESSION_NOT_FOUND:  로그아웃 대상 RefreshToken 이 본인 소유 아니거나 미존재 → 404(중립).
  //   ENCRYPTION_UNAVAILABLE: APP_ENCRYPTION_KEY 미설정 → 2FA 엔드포인트 graceful 503(크래시 금지).
  PASSWORD_INCORRECT = 'PASSWORD_INCORRECT',
  TOTP_CODE_REQUIRED = 'TOTP_CODE_REQUIRED',
  TOTP_INVALID = 'TOTP_INVALID',
  TOTP_ALREADY_ENABLED = 'TOTP_ALREADY_ENABLED',
  TOTP_NOT_ENABLED = 'TOTP_NOT_ENABLED',
  SESSION_NOT_FOUND = 'SESSION_NOT_FOUND',
  ENCRYPTION_UNAVAILABLE = 'ENCRYPTION_UNAVAILABLE',

  // S77c (D14 / FR-PS-16·19): 계정 비활성화/재활성화.
  //   ACCOUNT_DEACTIVATED:     비활성 계정의 인증 요청(JWT 이중검사) / 로그인 시도 → 403.
  //     로그인 응답에선 FE 가 "계정 복구" CTA 로 분기한다(자격증명 검증 후 reactivate 허용).
  //   ACCOUNT_NOT_DEACTIVATED: 활성 계정에서 reactivate 시도(상태 충돌) → 409.
  ACCOUNT_DEACTIVATED = 'ACCOUNT_DEACTIVATED',
  ACCOUNT_NOT_DEACTIVATED = 'ACCOUNT_NOT_DEACTIVATED',

  // S84a (D16 / FR-RC11): 인커밍 웹훅 / 봇 메시지.
  //   WEBHOOK_NOT_FOUND:     관리/회전/삭제 대상 웹훅 미존재(또는 타 워크스페이스) → 404.
  //   WEBHOOK_REVOKED:       폐기/회전된 토큰으로의 인커밍 POST → 403.
  //   WEBHOOK_INVALID_TOKEN: 토큰 미일치/형식오류 인커밍 POST → 403(존재 노출 회피).
  //   WEBHOOK_NAME_RESERVED: username/botDisplayName 예약어(system/qufox/admin) → 422.
  WEBHOOK_NOT_FOUND = 'WEBHOOK_NOT_FOUND',
  WEBHOOK_REVOKED = 'WEBHOOK_REVOKED',
  WEBHOOK_INVALID_TOKEN = 'WEBHOOK_INVALID_TOKEN',
  WEBHOOK_NAME_RESERVED = 'WEBHOOK_NAME_RESERVED',

  FORBIDDEN = 'FORBIDDEN',
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  NOT_FOUND = 'NOT_FOUND',
  RATE_LIMITED = 'RATE_LIMITED',
  INTERNAL = 'INTERNAL',
}

export const ERROR_CODE_HTTP_STATUS: Record<ErrorCode, number> = {
  [ErrorCode.AUTH_INVALID_TOKEN]: 401,
  [ErrorCode.AUTH_EMAIL_TAKEN]: 409,
  [ErrorCode.AUTH_USERNAME_TAKEN]: 409,
  [ErrorCode.AUTH_WEAK_PASSWORD]: 422,
  [ErrorCode.AUTH_INVALID_CREDENTIALS]: 401,
  [ErrorCode.AUTH_ACCOUNT_LOCKED]: 423,
  [ErrorCode.AUTH_SESSION_COMPROMISED]: 401,

  // S66 (D13 / FR-W05a/W05b/W21): 이메일 인증 + 도메인 게이트 상태코드.
  [ErrorCode.EMAIL_NOT_VERIFIED]: 403,
  [ErrorCode.WORKSPACE_DOMAIN_NOT_ALLOWED]: 403,
  [ErrorCode.EMAIL_VERIFICATION_RATE_LIMITED]: 429,
  [ErrorCode.EMAIL_VERIFICATION_TOKEN_EXPIRED]: 410,
  [ErrorCode.EMAIL_VERIFICATION_TOKEN_INVALID]: 400,

  [ErrorCode.WORKSPACE_NOT_FOUND]: 404,
  [ErrorCode.WORKSPACE_NOT_MEMBER]: 404,
  [ErrorCode.WORKSPACE_SLUG_TAKEN]: 409,
  [ErrorCode.WORKSPACE_SLUG_RESERVED]: 422,
  [ErrorCode.WORKSPACE_INSUFFICIENT_ROLE]: 403,
  [ErrorCode.WORKSPACE_CANNOT_DEMOTE_OWNER]: 403,
  [ErrorCode.WORKSPACE_CANNOT_REMOVE_OWNER]: 403,
  [ErrorCode.WORKSPACE_OWNER_MUST_TRANSFER]: 409,
  [ErrorCode.WORKSPACE_TARGET_NOT_MEMBER]: 404,
  [ErrorCode.WORKSPACE_ALREADY_MEMBER]: 409,
  [ErrorCode.WORKSPACE_PURGED]: 410,
  [ErrorCode.WORKSPACE_NOT_PUBLIC]: 403,
  [ErrorCode.WORKSPACE_DEFAULT_CHANNEL_NOT_PUBLIC]: 422,
  // S65 fix-forward (security A-2): APPLY 모드 즉시 가입 차단 → 409(상태 충돌 — 신청
  // 후 승인 모드라 즉시 가입이 처리 불가).
  [ErrorCode.WORKSPACE_APPLY_NOT_SUPPORTED]: 409,
  // S65 fix-forward (D-2): PUBLIC 전환 메타데이터 누락 → 422(처리 불가 — 도메인 불변식).
  [ErrorCode.WORKSPACE_PUBLIC_REQUIRES_METADATA]: 422,
  // S72 (D13 / FR-W15): 삭제 confirmation 불일치 → 422(처리 불가 — 파괴적 액션 게이트).
  [ErrorCode.WORKSPACE_CONFIRMATION_MISMATCH]: 422,

  // S61 (D12 / FR-RM01·04·15): 역할 시스템.
  [ErrorCode.ROLE_NOT_FOUND]: 404,
  [ErrorCode.ROLE_NAME_TAKEN]: 409,
  [ErrorCode.ROLE_SYSTEM_IMMUTABLE]: 403,
  // privilege escalation 거부는 403(권한 상승 차단 · FR-RM04).
  [ErrorCode.ROLE_PRIVILEGE_ESCALATION]: 403,
  [ErrorCode.ROLE_POSITION_TOO_HIGH]: 403,
  [ErrorCode.ROLE_INVALID_PERMISSIONS]: 422,
  // S63 (D12 / FR-RM05·06·07): 모더레이션 거부 매핑.
  [ErrorCode.MODERATION_TARGET_HIGHER]: 403,
  [ErrorCode.MODERATION_CANNOT_SELF]: 400,
  [ErrorCode.MEMBER_ALREADY_BANNED]: 409,
  [ErrorCode.MEMBER_NOT_BANNED]: 404,
  [ErrorCode.MEMBER_TIMED_OUT]: 403,
  [ErrorCode.KICK_UNDO_INVALID]: 409,
  // S64 (D12 / FR-RM09·11): bulk purge 상한 / 신고 중복·미존재·재처리.
  [ErrorCode.BULK_DELETE_LIMIT]: 400,
  [ErrorCode.REPORT_DUPLICATE]: 409,
  [ErrorCode.REPORT_NOT_FOUND]: 404,
  [ErrorCode.REPORT_ALREADY_RESOLVED]: 409,
  [ErrorCode.FRIEND_TARGET_NOT_FOUND]: 404,
  [ErrorCode.FRIEND_CANNOT_SELF]: 400,
  [ErrorCode.FRIEND_ALREADY]: 409,
  [ErrorCode.FRIEND_BLOCKED]: 403,
  [ErrorCode.FRIEND_REQUEST_DUPLICATE]: 409,
  [ErrorCode.FRIEND_NOT_FOUND]: 404,
  [ErrorCode.FRIEND_INVALID_STATE]: 409,
  [ErrorCode.FRIEND_CAP_REACHED]: 422,
  [ErrorCode.FRIEND_REQUEST_BLOCKED]: 403,
  // S16 (FR-DM-02): 그룹 DM cap 초과 → 422.
  [ErrorCode.DM_GROUP_CAP_EXCEEDED]: 422,
  // S19 (FR-DM-12): DM 수신권한 미충족 → 403.
  [ErrorCode.DM_PRIVACY_RESTRICTED]: 403,

  [ErrorCode.INVITE_NOT_FOUND]: 404,
  [ErrorCode.INVITE_EXPIRED]: 410,
  [ErrorCode.INVITE_EXHAUSTED]: 410,
  [ErrorCode.INVITE_REVOKED]: 410,
  [ErrorCode.BETA_INVITE_REQUIRED]: 403,

  // S68 (D13 / FR-W04·W04a·W05): 이메일 직접 초대 + 도메인 관리 매핑.
  [ErrorCode.EMAIL_INVITE_TOKEN_INVALID]: 400,
  [ErrorCode.EMAIL_INVITE_EXPIRED]: 410,
  [ErrorCode.EMAIL_INVITE_ROLE_MISMATCH]: 400,
  // S68 fix-forward (reviewer B1): 수락 actor 이메일 ↔ 초대 대상 이메일 불일치 → 403.
  [ErrorCode.EMAIL_INVITE_EMAIL_MISMATCH]: 403,
  [ErrorCode.EMAIL_INVITE_ALREADY_ACCEPTED]: 409,
  [ErrorCode.EMAIL_INVITE_NOT_FOUND]: 404,
  [ErrorCode.WORKSPACE_EMAIL_DOMAINS_FORBIDDEN]: 403,

  // S70 (D13 / FR-W06·W06a): 가입 신청 플로우 상태코드.
  [ErrorCode.APPLICATION_PENDING_EXISTS]: 409,
  [ErrorCode.APPLICATION_NOT_FOUND]: 404,
  [ErrorCode.APPLICATION_INVALID_STATE]: 409,
  [ErrorCode.APPLICATION_COOLDOWN]: 429,
  [ErrorCode.APPLICATION_FORBIDDEN]: 403,
  [ErrorCode.APPLICATION_NOT_APPLICABLE]: 409,

  // S71 (D13 / FR-W07·W08·W09): 워크스페이스 온보딩 상태코드.
  [ErrorCode.RULES_NOT_ACCEPTED]: 403,
  [ErrorCode.ONBOARDING_RULES_LIMIT]: 409,
  [ErrorCode.ONBOARDING_QUESTIONS_LIMIT]: 409,
  [ErrorCode.ONBOARDING_RULE_NOT_FOUND]: 404,
  [ErrorCode.ONBOARDING_QUESTION_NOT_FOUND]: 404,
  [ErrorCode.ONBOARDING_INVALID_OPTION]: 400,

  [ErrorCode.CHANNEL_NOT_FOUND]: 404,
  [ErrorCode.CHANNEL_NAME_TAKEN]: 409,
  [ErrorCode.CHANNEL_NAME_INVALID]: 422,
  [ErrorCode.CHANNEL_TYPE_NOT_IMPLEMENTED]: 422,
  [ErrorCode.CHANNEL_PURGED]: 410,
  [ErrorCode.CHANNEL_POSITION_INVALID]: 422,
  [ErrorCode.CHANNEL_ARCHIVED]: 409,
  // S13 (FR-CH-19): 공지 채널 게시 제한 → 403.
  [ErrorCode.CHANNEL_POSTING_RESTRICTED]: 403,
  // S14 (FR-CH-05): confirmName 누락/불일치는 400(검증 실패 계열).
  [ErrorCode.CHANNEL_CONFIRM_REQUIRED]: 400,
  // S14 (FR-CH-07): 비공개 채널 자유 가입 거부는 403.
  [ErrorCode.CHANNEL_PRIVATE_INVITE_ONLY]: 403,
  // S14 (FR-CH-07): 비멤버 탈퇴는 409(상태 충돌).
  [ErrorCode.CHANNEL_NOT_MEMBER]: 409,
  // S15 (FR-CH-08): 슬로우모드 활성은 429(rate-limit 계열) + retry-after.
  [ErrorCode.CHANNEL_SLOWMODE_ACTIVE]: 429,
  [ErrorCode.CATEGORY_NOT_FOUND]: 404,
  [ErrorCode.CATEGORY_NAME_TAKEN]: 409,
  // S43 (FR-CH-15): 즐겨찾기 재정렬 anchor 미존재는 404.
  [ErrorCode.FAVORITE_NOT_FOUND]: 404,

  [ErrorCode.MESSAGE_NOT_FOUND]: 404,
  [ErrorCode.MESSAGE_CONTENT_INVALID]: 422,
  [ErrorCode.MESSAGE_CURSOR_INVALID]: 400,
  // S02: 4,000자 초과는 400 (AC FR-MSG-03: "400 + MESSAGE_TOO_LONG").
  [ErrorCode.MESSAGE_TOO_LONG]: 400,
  // S00 carryover (FR-MSG-23): 파서 한도 위반은 모두 400.
  [ErrorCode.PARSE_TIMEOUT]: 400,
  [ErrorCode.PARSE_DEPTH_EXCEEDED]: 400,
  [ErrorCode.PARSE_NODE_LIMIT]: 400,
  [ErrorCode.PARSE_AST_TOO_LARGE]: 400,
  [ErrorCode.MESSAGE_NOT_AUTHOR]: 403,
  [ErrorCode.MESSAGE_THREAD_DEPTH_EXCEEDED]: 400,
  [ErrorCode.MESSAGE_PARENT_NOT_FOUND]: 404,
  // S38 (FR-TH-13): 잠긴 스레드 답글 차단(MEMBER 이하).
  [ErrorCode.THREAD_LOCKED]: 403,
  // S50 (D10 · FR-PS-04): hard cap(55) 초과 핀 거부는 423 Locked 로 매핑한다(PRD
  // 정본 "55개(hard limit) 초과 시 API가 423 Locked로 거부"). 종전 422 에서 변경.
  [ErrorCode.MESSAGE_PIN_CAP_EXCEEDED]: 423,
  // S05 (FR-MSG-06): 낙관적 잠금 충돌은 409 (IDEMPOTENCY_KEY_REUSE_CONFLICT 와 동일 매핑).
  [ErrorCode.MESSAGE_VERSION_CONFLICT]: 409,
  [ErrorCode.IDEMPOTENCY_KEY_REUSE_CONFLICT]: 409,
  // S39 (FR-RE02): 이모지 반응 종류 한도(20) 초과 → 409.
  [ErrorCode.REACTION_LIMIT_REACHED]: 409,

  [ErrorCode.ATTACHMENT_NOT_FOUND]: 404,
  [ErrorCode.ATTACHMENT_TOO_LARGE]: 413,
  [ErrorCode.ATTACHMENT_MIME_REJECTED]: 415,
  [ErrorCode.ATTACHMENT_NOT_UPLOADED]: 409,
  [ErrorCode.ATTACHMENT_SIZE_MISMATCH]: 409,
  [ErrorCode.CHANNEL_NOT_VISIBLE]: 403,

  [ErrorCode.CUSTOM_EMOJI_NOT_FOUND]: 404,
  [ErrorCode.CUSTOM_EMOJI_NAME_TAKEN]: 409,
  [ErrorCode.CUSTOM_EMOJI_NAME_INVALID]: 422,
  // S41 (FR-EM02): cap 초과는 409(상태 충돌).
  [ErrorCode.EMOJI_WORKSPACE_LIMIT]: 409,
  // S41 (FR-EM01 / FR-RC20): MIME/size 거부는 422(처리 불가).
  [ErrorCode.INVALID_FILE]: 422,
  // S42 (FR-EM05): 별칭 한도 초과 / 충돌은 409(상태 충돌).
  [ErrorCode.ALIAS_LIMIT]: 409,
  [ErrorCode.ALIAS_CONFLICT]: 409,
  // task-039-D: 422 (Unprocessable Entity) is more accurate than 400
  // — the request envelope is well-formed JSON with valid fields, but
  // the uploaded payload's magic bytes do not match the declared
  // mime, so the server cannot process it. 400 was reserved for
  // shape errors (parse failures / missing required fields).
  [ErrorCode.INVALID_MAGIC_BYTES]: 422,

  // S54 (D11): 업로드 세션/교차검증/rate-limit 매핑.
  [ErrorCode.ATTACHMENT_SESSION_NOT_FOUND]: 404,
  [ErrorCode.ATTACHMENT_SESSION_EXPIRED]: 410,
  [ErrorCode.ATTACHMENT_EXTENSION_BLOCKED]: 400,
  [ErrorCode.ATTACHMENT_COUNT_EXCEEDED]: 400,
  [ErrorCode.MIME_MISMATCH]: 400,
  [ErrorCode.UPLOAD_RATE_LIMIT]: 429,
  [ErrorCode.FILE_UPLOAD_DISABLED]: 403,

  // S51 (FR-PS-07): 개인 저장함 한도(500) 초과는 422(처리 불가).
  [ErrorCode.SAVED_LIMIT_EXCEEDED]: 422,
  [ErrorCode.SAVED_NOT_FOUND]: 404,
  // S80 (D15 / FR-SC-04·05·06): 슬래시 커맨드 실행 상태코드.
  [ErrorCode.SLASH_COMMAND_UNKNOWN]: 404,
  [ErrorCode.SLASH_COMMAND_NOT_EXECUTABLE]: 422,
  [ErrorCode.REMINDER_PARSE_FAILED]: 400,
  [ErrorCode.REMINDER_NOT_FOUND]: 404,
  // S81b (D15 / FR-SC-07): GIPHY 프록시 불가 → 503(graceful·ENCRYPTION_UNAVAILABLE 선례).
  [ErrorCode.GIPHY_UNAVAILABLE]: 503,
  // S81c (D15 / FR-SC-09·10): 커스텀 슬래시 커맨드 CRUD 상태코드.
  [ErrorCode.SLASH_COMMAND_BUILTIN_CONFLICT]: 409,
  [ErrorCode.SLASH_COMMAND_DUPLICATE]: 409,
  [ErrorCode.SLASH_COMMAND_NOT_FOUND]: 404,
  // S73 (D14 / FR-PS-01/02/03): 프로필/아바타.
  [ErrorCode.HANDLE_TAKEN]: 409,
  [ErrorCode.HANDLE_COOLDOWN_ACTIVE]: 400,
  [ErrorCode.FILE_TOO_LARGE]: 413,
  [ErrorCode.INVALID_MIME]: 415,
  // S77b (D14 / FR-PS-15·20): 보안(자격증명 변경·TOTP·세션) 상태코드.
  [ErrorCode.PASSWORD_INCORRECT]: 403,
  [ErrorCode.TOTP_CODE_REQUIRED]: 403,
  [ErrorCode.TOTP_INVALID]: 403,
  [ErrorCode.TOTP_ALREADY_ENABLED]: 409,
  [ErrorCode.TOTP_NOT_ENABLED]: 409,
  [ErrorCode.SESSION_NOT_FOUND]: 404,
  [ErrorCode.ENCRYPTION_UNAVAILABLE]: 503,
  // S77c (D14 / FR-PS-16·19): 계정 비활성화/재활성화 상태코드.
  [ErrorCode.ACCOUNT_DEACTIVATED]: 403,
  [ErrorCode.WEBHOOK_NOT_FOUND]: 404,
  [ErrorCode.WEBHOOK_REVOKED]: 403,
  [ErrorCode.WEBHOOK_INVALID_TOKEN]: 403,
  [ErrorCode.WEBHOOK_NAME_RESERVED]: 422,
  [ErrorCode.ACCOUNT_NOT_DEACTIVATED]: 409,
  [ErrorCode.FORBIDDEN]: 403,
  [ErrorCode.VALIDATION_FAILED]: 400,
  [ErrorCode.KEYWORD_LIMIT_EXCEEDED]: 400,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.RATE_LIMITED]: 429,
  [ErrorCode.INTERNAL]: 500,
};
