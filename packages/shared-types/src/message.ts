import { z } from 'zod';
import { Cuid2Schema } from './mrkdwn';
import { RichTextRootSchema } from './mrkdwn-ast';
import { MessageTypeSchema } from './message-type';
import { MessageEmbedDtoSchema } from './links';
import { RichEmbedArraySchema } from './rich-embed';

export const MESSAGE_MAX_LENGTH = 4000;

export const MessageContentSchema = z.string().min(1).max(MESSAGE_MAX_LENGTH);

// 과도기(expand-contract) ID: 라이브 데이터는 아직 uuid, mrkdwn 파서는
// cuid2 토큰을 추출 → 둘 다 허용한다. S01 데이터 마이그레이션 완료 후
// Cuid2Schema 단독으로 좁힌다(현재 좁히면 라이브 uuid 멘션이 깨짐).
export const TransitionalIdSchema = z.string().uuid().or(Cuid2Schema);

export const MessageMentionsSchema = z.object({
  // ADR-1 / FR-RC22: 멘션 ID. 과도기엔 uuid|cuid2 둘 다 수용(위 NOTE).
  // 이전 `z.string().uuid()` 단독은 파서가 뽑은 cuid2 토큰을 거부해
  // MessageUpdatedPayload.mentions 가 런타임에서 깨졌다(리뷰 [H2]).
  // NOTE(S01): id/channelId/authorId 등 나머지 ID 필드 + 본 union 의
  // cuid2 단독 전환은 S01 마이그레이션에서 처리.
  users: z.array(TransitionalIdSchema),
  channels: z.array(TransitionalIdSchema),
  everyone: z.boolean(),
  // task-047 iter0 (HIGH-046-B carry-over): `@here` 멘션 — 채널 멤버 중
  // 현재 online 인 사람만. 046 iter8 에 extractor + gate 는 추가됐지만
  // schema/event payload 미플러밍 → 047 에서 e2e 보강. default(false)
  // 로 기존 row 의 forward-compat 보장 (DB JSONB 가 here 키 누락이어도
  // 응답 schema 에서 false 채움).
  here: z.boolean().default(false),
  // S21 fix-forward (FR-RS-16 · MAJOR-D): `@channel` 범위 멘션 — 현재 채널
  // 멤버 전원. mention-extractor 와 gate.ts 는 이미 `channel` 을 산출/게이트하나
  // 와이어 스키마에 누락돼 toMessageRow 가 드롭 → live 수신 시 dispatcher 의
  // isMention 이 @channel 을 무시해 배지가 reload 와 불일치했다. default(false)
  // 로 기존 row(channel 키 누락) forward-compat.
  channel: z.boolean().default(false),
  // S88a (FR-MN-03): `@<RoleName>` 멘션이 가리키는 역할 id 목록. 서버가 본문에서
  // 알려진 워크스페이스 역할명을 longest-match 로 권위 추출해 게이트(mentionable
  // 또는 MENTION_EVERYONE)를 통과한 roleId 만 저장한다. 클라이언트는 user/channel
  // 과 동일하게 이 값을 신뢰하되 송신 시 힌트로 보내지는 않는다(SendMessageRequest
  // 의 mentions intent 에 roles 없음 — 역할은 서버 본문 추출이 단일 권위). default([])
  // 로 roles 키가 없는 legacy JSON row 도 forward-compat(safeParse → []).
  roles: z.array(TransitionalIdSchema).default([]),
});
export type MessageMentions = z.infer<typeof MessageMentionsSchema>;

// Opaque cursor (FR-MSG-21): base64url(JSON.stringify({ id, createdAt })). The
// UI MUST treat the string as an opaque token — encode/decode is server-side
// only.
//
// S03 NOTE(expand-contract wire compat): the canonical payload shape per
// FR-MSG-21 is `{ id, createdAt }`. The legacy slice shipped `{ t, id }`
// tokens, so the decoder accepts BOTH on the read path (a live client may
// still hold a `{ t, id }` token across the deploy) but the encoder only
// ever emits the canonical `{ id, createdAt }` form.
//
// NOTE(S03 review MAJOR #2): the cursor `id` is UUID-ONLY — NOT the
// transitional uuid|cuid2 union. `Message.id` is `@db.Uuid`, the API read path
// binds `$4::uuid` (a cuid2 cursor would throw a Postgres cast error), and
// `around` is `z.string().uuid()`. Loosening to cuid2 here was premature and
// inconsistent with the SQL/PK reality; if the S01 PK→cuid2 transition ever
// lands, re-loosen this schema, the API decoder, AND the SQL cast together.
export const CursorStringSchema = z.string().min(1).max(512);
// Canonical FR-MSG-21 payload. `createdAt` is an ISO-8601 instant; `id` is a
// uuid (matches the live `@db.Uuid` PK + the `$4::uuid` read-path cast).
export const CursorIdSchema = z.string().uuid();
export const CursorPayloadSchema = z.object({
  id: CursorIdSchema,
  createdAt: z.string().datetime(),
});
export type CursorPayload = z.infer<typeof CursorPayloadSchema>;

// Task-013-B: per-message reaction summary. `byMe` is viewer-scoped so
// the same message row can serialize differently depending on which
// authenticated user hits the endpoint.
//
// S39 계약 구분(SHOULD 3): ReactionSummary 는 **per-viewer** 형태다 — REST 응답
// (메시지 목록 / 단건 GET) 이 인증된 뷰어 기준으로 `byMe`(불리언)를 직접 채워
// 내려보낸다. 반면 events.ts 의 ReactionUpdatedReaction 은 **broadcast** 형태로,
// per-viewer `me` 를 담지 못해(수신자마다 다름) `users:[…≤5]` 만 싣고 클라가
// byMe 를 로컬 계산한다. 둘은 용도(per-viewer REST vs broadcast WS)가 다른 별개
// 계약이며 서로 변환되지 않는다 — 혼동 주의.
export const ReactionSummarySchema = z.object({
  emoji: z.string().min(1).max(64),
  count: z.number().int().nonnegative(),
  byMe: z.boolean(),
  // S41 (FR-EM06 / FR-RC20): 커스텀 이모지 반응이면 참조 CustomEmoji.id 와
  // presigned `url` 을 동봉한다. 유니코드 반응이면 둘 다 생략(undefined)이며,
  // **커스텀 이모지가 삭제된** 반응 행은 customEmojiId 가 null 로 풀려 emoji
  // (`:name:`) 텍스트만 남는다 — UI 가 [삭제된 이모지] placeholder 로 표시한다.
  // 셋 다 optional/nullable 이라 구 클라이언트/구 API 응답과 forward-compat.
  customEmojiId: z.string().uuid().nullable().optional(),
  url: z.string().nullable().optional(),
  // 072-N0 (FR-RE04, audit 2026-06-13-desktop-uiux-audit.md): 반응 칩 hover
  // 툴팁("A, B 외 N명")용 미리보기 반응자. 이모지당 최대 5명(안정 정렬 — 최초
  // createdAt ASC, GET reactions 가 보유한 동일 cap). per-viewer REST 목록 read-path
  // 가 채워 ReactionBar 가 호버 즉시 소비한다. forward-compat optional — 구
  // 클라이언트/구 API 응답은 무시하고, 채워지지 않은 경로는 [] 폴백으로 다룬다.
  previewUsers: z
    .array(
      z.object({
        id: z.string(),
        username: z.string(),
        displayName: z.string().nullable().optional(),
      }),
    )
    .max(5)
    .optional(),
});
export type ReactionSummary = z.infer<typeof ReactionSummarySchema>;

// Task-014-B / S33 (FR-TH-16): root messages expose a thread summary
// (PRD threadMeta). replyCount / lastRepliedAt(=latestReplyAt) 는 S33 의
// Message 비정규화 컬럼을 직접 반환하며 별도 집계 쿼리를 돌리지 않는다.
// recentReplyUserIds(=replyParticipants)는 N+1 없는 bounded LATERAL 로
// 모은 최근 distinct author 들로, 아바타 스택용이다. `null`/`[]` 는 답글이
// 없을 때(UI 가 reply bar 를 감춘다)를 뜻한다.
// S33: cap 을 3 → 5 로 상향(FR-TH-03/16 "최초 답글자 최대 5명"). 서버
// THREAD_REPLY_PARTICIPANT_CAP 과 동일 값을 유지한다.
export const ThreadSummarySchema = z.object({
  replyCount: z.number().int().nonnegative(),
  // 컬럼↔와이어 매핑(S33 fix-forward 문서 갭): DB 컬럼명은 `Message.latestReplyAt`
  // (timestamptz)이고, 와이어 필드명은 `lastRepliedAt`(ISO 문자열)다. 서버
  // aggregateThreadSummaries 가 `latestReplyAt` → `lastRepliedAt` 으로 변환해
  // 직렬화한다(런타임 정합은 OK, 명칭만 다름 — 혼동 방지용 주석).
  lastRepliedAt: z.string().datetime().nullable(),
  recentReplyUserIds: z.array(z.string().uuid()).max(5),
  // S36 (FR-TH-04 / FR-TH-11 / FR-RS-12): per-viewer 스레드 미읽 여부. reply bar
  // (qf-thread-chip)에 파란 unread dot 을 띄울지 결정한다. 채널 메시지 목록
  // read-path 가 viewer 의 ThreadReadState 와 배치 조인해 산정한다(N+1 없음 —
  // 루트 집합 단일 쿼리). 이 viewer 정보가 없는 경로(WS dispatcher 가 합성하는
  // ThreadSummary, broadcast)는 false 폴백 — default(false) 라 forward-compat.
  // boolean 인 이유: 정확한 미읽 카운트는 패널을 열 때 계산하면 충분하고, chip
  // 은 "안 읽은 답글이 있다" 만 시각화하면 되기 때문(denormalized count 컬럼은
  // 두지 않는다는 S36 옵션 B 결정과 일관 — count 표시는 Threads 탭 S38).
  hasUnread: z.boolean().default(false),
});
export type ThreadSummary = z.infer<typeof ThreadSummarySchema>;

// Trimmed Attachment projection embedded on each MessageDto. The
// upload flow stays the same (presigned upload + finalize), but the
// message list endpoint now returns the attachments inline so the UI
// can render images / videos / file cards without an extra fan-out.
// Mirrors `apps/web/src/features/messages/AttachmentsList.tsx`'s
// AttachmentLite interface.
// S54 (D11 / FR-AM-03): 첨부 후처리 상태. Prisma AttachmentStatus enum 과 1:1.
export const AttachmentStatusSchema = z.enum([
  'PENDING',
  'PROCESSING',
  'READY',
  'FAILED',
  'BLOCKED',
]);
export type AttachmentStatus = z.infer<typeof AttachmentStatusSchema>;

export const AttachmentLiteSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['IMAGE', 'VIDEO', 'FILE']),
  mime: z.string().min(1).max(255),
  sizeBytes: z.number().int().nonnegative(),
  originalName: z.string().min(1).max(512),
  // ── S54 (D11) 확장 — 전부 optional/default 라 구 API 빌드 응답과 forward-compat ──
  // 서버가 magic-byte 재검증으로 확정한 실제 MIME(없으면 declared mime 사용).
  storedMimeType: z.string().min(1).max(127).nullable().optional(),
  // 썸네일 presigned URL 또는 키(후처리 파이프라인은 S55+ — 현재 항상 null).
  thumbnailKey: z.string().nullable().optional(),
  // 이미지/비디오 픽셀 크기(클라 신고 — 표시용).
  width: z.number().int().positive().nullable().optional(),
  height: z.number().int().positive().nullable().optional(),
  // 대체 텍스트(접근성).
  altText: z.string().max(2000).nullable().optional(),
  // 스포일러 표식(클릭 전 블러). default(false) 로 구 응답 forward-compat.
  isSpoiler: z.boolean().default(false),
  // 다중 첨부 정렬 순서.
  sortOrder: z.number().int().nonnegative().default(0),
  // 후처리 상태. default('READY') — S54 는 후처리 파이프라인이 없어 링크 즉시 표시
  // 가능하므로(PENDING 이어도 UI 는 노출), 구 응답(필드 누락)을 READY 로 폴백한다.
  processingStatus: AttachmentStatusSchema.default('READY'),
});
export type AttachmentLite = z.infer<typeof AttachmentLiteSchema>;

export const MessageDtoSchema = z.object({
  id: z.string().uuid(),
  channelId: z.string().uuid(),
  authorId: z.string().uuid(),
  content: MessageContentSchema.nullable(),
  // S02 (ADR-2 / FR-RC02): rich content 송수신 코어. 기존 `content` 와
  // 병행하는 additive 필드 — 구 클라이언트는 무시하고 신규 렌더러는
  // contentAst 를 우선 사용합니다. 서버가 채우기 전 row(또는 SYSTEM 메시지)
  // 는 둘 다 null 이라 forward-compat. deleted 메시지는 마스킹되어 null.
  contentRaw: z.string().nullable().default(null),
  contentAst: RichTextRootSchema.nullable().default(null),
  // S37 (FR-MSG-17): 평문 정본. "메시지 복사" 가 마크다운(content) 대신 사람이
  // 읽는 평문을 복사하도록 서버가 contentPlainV2(없으면 legacy contentPlain)를
  // 직렬화해 내려보냅니다. 삭제 메시지는 content 와 동일 정책으로 null 마스킹.
  // default(null) 라 구 API 빌드 응답(필드 누락)도 forward-compat — 클라이언트는
  // 이 값이 없으면 content 로 폴백합니다(resolveCopyPlainText).
  contentPlain: z.string().nullable().default(null),
  // S04 (ADR-2 / FR-MSG-19 / FR-RC10): 메시지 타입. 기존 row 와 구
  // 클라이언트는 DEFAULT 로 forward-compat. SYSTEM_* 타입은 렌더러가
  // 시스템 행(아이콘 + 이탤릭, 편집·삭제 미표시)으로 표시하고 그루핑에서
  // grouped=false 를 강제합니다.
  type: MessageTypeSchema.default('DEFAULT'),
  // S84a (D16 / FR-RC11): 작성자 분류. 인커밍 웹훅 게시 메시지는 'BOT' 으로 내려가
  // 클라이언트가 BOT 배지(.qf-badge--accent) + botUsername/botAvatarUrl override 를
  // 렌더한다. 일반 사용자 메시지는 'USER', 시스템 행은 'SYSTEM'. optional 이라 구 API
  // 빌드 응답·기존 MessageDto 리터럴(필드 누락)도 forward-compat — 누락(undefined)은
  // 클라이언트가 일반 사용자(USER)로 취급한다(`=== 'BOT'` 분기만 BOT 경로 진입).
  authorType: z.enum(['USER', 'BOT', 'SYSTEM']).optional(),
  // S84a (FR-RC11): 봇 메시지 표시 override. authorType==='BOT' 일 때만 채워진다.
  // 서버가 게시 시점에 (요청 username → 웹훅 botDisplayName → 웹훅 name) 순으로
  // 최종 표시명을 해석해 저장하므로 클라이언트는 추가 룩업 없이 그대로 렌더한다
  // (웹훅 삭제로 webhookId 가 SetNull 돼도 표시명/아바타는 메시지에 남아 보존).
  // 일반/시스템 메시지는 둘 다 null/미포함. optional 이라 forward-compat.
  botUsername: z.string().nullable().optional(),
  botAvatarUrl: z.string().nullable().optional(),
  mentions: MessageMentionsSchema,
  edited: z.boolean(),
  deleted: z.boolean(),
  createdAt: z.string().datetime(),
  editedAt: z.string().datetime().nullable(),
  // Default to [] so clients on older API builds don't break — this
  // keeps the schema forwards-compatible during gradual rollout.
  reactions: z.array(ReactionSummarySchema).default([]),
  // task-014-B: null for replies (thread panel context) OR root messages
  // that haven't been replied to yet — the UI branches on presence+count.
  parentMessageId: z.string().uuid().nullable().default(null),
  thread: ThreadSummarySchema.nullable().default(null),
  // Inline attachments per message (IMAGE / VIDEO / FILE). Default `[]`
  // for older API builds and for messages that were sent without an
  // attachment batch.
  attachments: z.array(AttachmentLiteSchema).default([]),
  // task-044-iter2: pinned message marker. `null` when 미고정.
  // `pinnedBy` 는 OWNER/ADMIN 의 userId — author 와 다를 수 있다.
  pinnedAt: z.string().datetime().nullable().default(null),
  pinnedBy: z.string().uuid().nullable().default(null),
  // S05 (FR-MSG-06): 낙관적 잠금 버전. 편집 시 +1 됩니다. 클라이언트는
  // 편집창 오픈 시 이 값을 스냅샷해 PATCH 의 expectedVersion 으로 보내고,
  // 서버는 version 불일치 시 409 + 현재 DTO 를 반환합니다. default(0) 라
  // 구 API 빌드 응답(version 누락)도 forward-compat 합니다.
  // 상한은 Postgres INT4 최대값(2,147,483,647) — DB 컬럼이 Int 라 초과 시
  // 쿼리 단계에서 numeric overflow(500) 가 나므로 계약 레벨에서 막습니다.
  version: z.number().int().nonnegative().max(2_147_483_647).default(0),
  // S35 (FR-TH-06 / FR-TH-14): 스레드→채널 broadcast 표식. true 면 이 메시지는
  // 답글의 채널 타임라인 복제본(SYSTEM_THREAD_BROADCAST 행)이며, parentMessageId
  // 는 스레드 루트를 가리킨다(클릭 시 스레드 열림). default(false) 라 구 API
  // 빌드 응답(필드 누락)도 forward-compat.
  isBroadcast: z.boolean().default(false),
  // S35 (FR-TH-06): broadcast 행에만 채워지는 루트 메시지 excerpt(50자, 초과 시
  // 끝에 "…"). 클라이언트가 "스레드에 답글" 레이블과 함께 표시한다. broadcast 가
  // 아닌 일반 메시지는 null.
  parentExcerpt: z.string().nullable().default(null),
  // S38 (FR-TH-13): 스레드 잠금 표식. 루트 메시지에만 의미가 있다(답글은 항상
  // false). 스레드 패널이 헤더 잠금 아이콘 + composer disabled 판정에 쓴다.
  // default(false) 라 구 API 빌드 응답(필드 누락)도 forward-compat.
  threadLocked: z.boolean().default(false),
  // S60 (FR-RC07/08 · FR-AM-13~16): 본문 URL 의 비동기 unfurl 결과(OG 카드).
  // 메시지 발화 직후 응답에는 보통 비어 있고(워커가 아직 fetch 중), 잠시 뒤
  // message:embed_updated WS 이벤트로 채워진다. suppress 되거나 삭제된 메시지는
  // 서버가 [] 로 마스킹한다. default([]) 라 구 API 빌드 응답(필드 누락)도 forward-compat.
  embeds: z.array(MessageEmbedDtoSchema).default([]),
  // S84b (D16 / FR-RC12): 봇/웹훅 rich embed 배열(Discord 스타일). S60 unfurl `embeds`
  // 와 별개 필드 — 웹훅 게시 시점에 통째 제공되는 불변 데이터를 Message.richEmbeds(JSON)
  // 에서 그대로 내려보낸다. optional 이라 기존 MessageDto 리터럴·구 API 빌드(필드 누락)
  // 모두 forward-compat — 클라이언트는 누락(undefined)을 빈 배열로 취급한다.
  richEmbeds: RichEmbedArraySchema.optional(),
});
export type MessageDto = z.infer<typeof MessageDtoSchema>;

// S35 (FR-TH-06): broadcast excerpt 길이 상한. 초과 시 (cap-1)자 + "…".
// 변경 시 서버 buildThreadBroadcastExcerpt 와 동일 값으로 유지해야 합니다.
export const THREAD_BROADCAST_EXCERPT_CAP = 50;

// task-044-iter2: pinned messages — Discord-parity cap 50/channel.
// S50 (D10 · FR-PS-04): 50 은 **soft** cap(도달 시 클라 경고 toast). 실제 거부
// 경계는 HARD_PIN_CAP=55 다 — 50~55 구간은 경고만 띄우고 핀을 허용하며, 55 초과
// 시도만 API 가 423 으로 거부한다(MESSAGE_PIN_CAP_EXCEEDED 매핑 422→423).
export const MESSAGE_PIN_CAP = 50;
export const HARD_PIN_CAP = 55;

export const PinMessageResponseSchema = z.object({
  id: z.string().uuid(),
  pinnedAt: z.string().datetime(),
  pinnedBy: z.string().uuid(),
});
export type PinMessageResponse = z.infer<typeof PinMessageResponseSchema>;

export const ListPinsResponseSchema = z.object({
  items: z.array(MessageDtoSchema),
  cap: z.number().int().positive(),
  used: z.number().int().nonnegative(),
});
export type ListPinsResponse = z.infer<typeof ListPinsResponseSchema>;

// S50 (D10 · FR-PS-03): 채널 헤더 핀 카운트 배지용 경량 응답(본문 없이 수/한도만).
export const PinCountResponseSchema = z.object({
  used: z.number().int().nonnegative(),
  cap: z.number().int().positive(),
});
export type PinCountResponse = z.infer<typeof PinCountResponseSchema>;

// POST /messages/:id/reactions + DELETE counterpart — simple enough we
// reuse the ReactionSummary shape on the response.
export const AddReactionRequestSchema = z.object({
  emoji: z.string().min(1).max(64),
});
export type AddReactionRequest = z.infer<typeof AddReactionRequestSchema>;

// ── S39 (FR-RE04): GET /messages/:id/reactions ────────────────────────────
// 이모지별 { emoji, count, users:[…최대 5명] } 집계를 반환합니다. `users` 항목은
// id + username(미해결 시 null) 만 노출합니다(PII 최소화). 전체 reactor 목록의
// cursor 페이지네이션은 FR-RE05(S40 carryover)에서 별도 엔드포인트로 다룹니다.
// reaction:updated WS payload 의 reactions 배열과 동일한 항목 형태입니다(콜론
// wire 스키마는 events.ts 가 별도로 보유 — 모듈 순환을 피하려 여기에 독립 정의).
export const ReactionUserLiteSchema = z.object({
  id: z.string().uuid(),
  username: z.string().nullable(),
});
export type ReactionUserLite = z.infer<typeof ReactionUserLiteSchema>;

export const ReactionDetailSchema = z.object({
  emoji: z.string().min(1).max(64),
  count: z.number().int().nonnegative(),
  users: z.array(ReactionUserLiteSchema).max(5),
  // S41 (FR-EM06 / FR-RC20): 커스텀 이모지 반응이면 CustomEmoji.id + presigned url.
  // 삭제된 커스텀 이모지 반응은 customEmojiId=null(emoji 슬러그만 남음).
  // optional/nullable → 구 응답과 forward-compat.
  customEmojiId: z.string().uuid().nullable().optional(),
  url: z.string().nullable().optional(),
});
export type ReactionDetail = z.infer<typeof ReactionDetailSchema>;

// S39 (SHOULD 3): 이 응답 형태는 서버 messages.service `aggregateReactionDetails`
// 의 반환 형태({ emoji, count, users:[{id, username|null}] }[])와 1:1 로 일치해야
// 한다(컨트롤러 list 가 그대로 감싸 반환). message.spec.ts 의 계약 회귀 테스트가
// 대표 샘플을 safeParse 로 고정해 둘이 어긋나면 곧바로 깨지게 한다.
export const ListReactionsResponseSchema = z.object({
  reactions: z.array(ReactionDetailSchema),
});
export type ListReactionsResponse = z.infer<typeof ListReactionsResponseSchema>;

// ── S40 (FR-RE05): GET /messages/:id/reactions/:emoji/users ─────────────────
// 한 이모지에 반응한 *전체* reactor 목록을 cursor 기반 페이지네이션으로 반환한다
// (기본 limit 50, 최대 100). FR-RE04 의 GET reactions 가 이모지당 최대 5명만
// 싣는 것과 달리, 이 엔드포인트는 "👍 32명" 칩을 눌렀을 때 32명 전원을 무한
// 스크롤로 펼치기 위한 것이다. 정렬은 (createdAt ASC, id ASC) — 최초 반응자부터
// 안정 정렬하며, `nextCursor` 는 메시지 목록과 동일한 opaque base64url({id,createdAt})
// 토큰이다(더 페이지가 없으면 null). user 항목은 id + username(미해결 시 null)만
// 노출한다(PII 최소화 — ReactionUserLite 재사용).
export const ListReactionUsersResponseSchema = z.object({
  users: z.array(ReactionUserLiteSchema),
  nextCursor: z.string().nullable(),
});
export type ListReactionUsersResponse = z.infer<typeof ListReactionUsersResponseSchema>;

// FR-RE05: reactor 목록 페이지네이션 한도. 기본 50 / 최대 100(메시지 목록과 동일).
export const REACTION_USERS_DEFAULT_LIMIT = 50;
export const REACTION_USERS_MAX_LIMIT = 100;

export const ListReactionUsersQuerySchema = z.object({
  cursor: CursorStringSchema.optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(REACTION_USERS_MAX_LIMIT)
    .default(REACTION_USERS_DEFAULT_LIMIT),
});
export type ListReactionUsersQuery = z.infer<typeof ListReactionUsersQuerySchema>;

export const SendMessageRequestSchema = z.object({
  content: MessageContentSchema,
  // S03 (FR-MSG-04): clientNonce — a UUID v4 the client generates ONCE per
  // logical send. It is echoed back on the `message:created` WS event so the
  // sending tab can swap its optimistic (pending) row for the confirmed one.
  // The SAME value is sent in the `Idempotency-Key` header for server-side
  // dedupe; the client never mints a separate tempId (single-identifier
  // contract, D17). Optional so older clients / system callers still work.
  nonce: z.string().uuid().optional(),
  // task-014-B: optional reply target. Server validates that the parent
  // exists, lives in the same channel, and is itself a root message
  // (single-level depth — parent.parentMessageId must be null).
  parentMessageId: z.string().uuid().optional(),
  // Previously-uploaded attachments to link to this message. Each id
  // must reference a finalized Attachment row for the same channel
  // that the uploader still owns; the server rejects mismatches.
  // Cap 10 per message matches the DS attachment grid's max visible
  // count — large galleries belong in a separate upload batch.
  attachmentIds: z.array(z.string().uuid()).max(10).optional(),
  // S21 (FR-RS-16): composer 가 멘션 피커로 선택한 특수멘션 의도(@everyone /
  // @here / @channel). 서버는 user/channel 멘션을 본문 텍스트에서 권위적으로
  // 재추출하지만, 특수멘션은 본문에 sigil 이 없을 수도 있어(피커 선택만) 클라
  // 힌트를 OR 로 병합한 뒤 gate.ts 로 권한 게이트한다. 권한 없는 특수멘션은
  // 저장 시 false 로 다운그레이드되므로 신뢰 경계는 유지된다.
  mentions: z
    .object({
      everyone: z.boolean().optional(),
      here: z.boolean().optional(),
      channel: z.boolean().optional(),
    })
    .optional(),
  // S35 (FR-TH-06): 'Also send to #channel' 체크. true 이고 parentMessageId 가
  // 있으면(=답글 전송) send tx 안에서 SYSTEM_THREAD_BROADCAST 행을 채널
  // 타임라인에 동시 게시한다. parentMessageId 없이 isBroadcast=true 만 보내면
  // 무시한다(루트/일반 send 에는 broadcast 개념이 없음). default(false).
  isBroadcast: z.boolean().optional(),
  // S94 (067 / FR-MSG-14): 대규모 범위 멘션(@everyone 워크스페이스 멤버수 ≥6 ·
  // @here/@channel ≥50) 전송 확인 토큰. 클라이언트가 서버 409(BULK_MENTION_CONFIRM_REQUIRED)
  // 를 받고 확인 dialog 를 거친 뒤 true 로 **동일 nonce** 재전송한다(같은 Idempotency-Key·
  // 같은 낙관행 재사용 — 잔류 실패행 없음, useMessages.ts 의 onBulkMentionConfirmRequired 가
  // 원래 clientNonce 를 위임). 미동봉/false 면 서버가 게이트 통과 후·INSERT 전에 임계값을
  // 검사해 초과 시 409 를 던진다(idempotencyKey 미소비).
  bulkMentionConfirmed: z.boolean().optional(),
});
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;

export const UpdateMessageRequestSchema = z.object({
  content: MessageContentSchema,
  // S05 (FR-MSG-06): 낙관적 잠금. 편집창 오픈 시점의 MessageDto.version
  // 스냅샷을 항상 동봉합니다. 서버 측 version 과 불일치하면 409 +
  // MESSAGE_VERSION_CONFLICT (현재 MessageDto 포함) 로 거부합니다.
  // 상한 = Postgres INT4 max. 초과값은 WHERE version=:expected 바인딩 시
  // overflow(500) 를 유발하므로 계약에서 차단합니다.
  expectedVersion: z.number().int().nonnegative().max(2_147_483_647),
  // S94 fix-forward (067 / FR-MSG-14 · HIGH-1): 편집으로 *새로* 추가한 대규모 범위
  // 멘션(@everyone 워크스페이스 멤버수 ≥6 · @here/@channel ≥50) 확인 토큰. send 와
  // 동일하게 클라이언트가 서버 409(BULK_MENTION_CONFIRM_REQUIRED)를 받고 확인 dialog 를
  // 거친 뒤 true 로 재편집한다. 미동봉/false 면 서버가 신규 broad 추가 시 UPDATE 쓰기
  // 전에 임계값을 검사한다(편집이 미적용 상태로 거부). 이미 있던 멘션의 내용만 바꾸는
  // 편집은 신규추가가 아니라 재확인을 요구하지 않는다.
  bulkMentionConfirmed: z.boolean().optional(),
});
export type UpdateMessageRequest = z.infer<typeof UpdateMessageRequestSchema>;

// ── S05 (FR-MSG-06 / FR-RC16): 메시지 편집 이력 ────────────────────────────
// 편집 시 직전 본문 스냅샷을 MessageEditHistory 에 적재합니다. 작성자 본인
// 또는 MANAGE_MESSAGES 권한자만 GET .../:msgId/history 로 최대 10개(ring
// buffer)까지 조회할 수 있습니다(일반 멤버는 403). FR-MSG-08 의 이력
// 팝오버 UI 는 S06 에서 이 계약을 소비합니다.
export const EDIT_HISTORY_CAP = 10;

export const EditHistoryDtoSchema = z.object({
  // 스냅샷 당시(편집 전) 메시지 version.
  version: z.number().int().nonnegative(),
  contentRaw: z.string().nullable(),
  contentAst: RichTextRootSchema.nullable(),
  contentPlain: z.string(),
  // 스냅샷 생성(=해당 편집 발생) 시각.
  editedAt: z.string().datetime(),
});
export type EditHistoryDto = z.infer<typeof EditHistoryDtoSchema>;

export const ListEditHistoryResponseSchema = z.object({
  // version desc (최신 편집 먼저), 최대 EDIT_HISTORY_CAP 개.
  items: z.array(EditHistoryDtoSchema).max(EDIT_HISTORY_CAP),
});
export type ListEditHistoryResponse = z.infer<typeof ListEditHistoryResponseSchema>;

export const ListMessagesQuerySchema = z
  .object({
    before: CursorStringSchema.optional(),
    after: CursorStringSchema.optional(),
    around: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    includeDeleted: z
      .union([z.boolean(), z.enum(['true', 'false'])])
      .optional()
      .transform((v) => v === true || v === 'true'),
    // S03 (FR-MSG-21 edge case): `lastReadMessageId` is a READ-STATE cursor,
    // NOT a pagination cursor. The pagination contract uses opaque
    // base64url(JSON{id,createdAt}) tokens only. Accepting `lastReadMessageId`
    // here lets us reject it explicitly (400) instead of silently ignoring
    // it — mixing the two cursor namespaces is a client bug we surface loudly.
    lastReadMessageId: z.string().optional(),
  })
  .refine((q) => [q.before, q.after, q.around].filter(Boolean).length <= 1, {
    message: 'before / after / around are mutually exclusive',
  })
  .refine((q) => q.lastReadMessageId === undefined, {
    message:
      'lastReadMessageId must not be used as a pagination cursor — use the opaque before/after token',
    path: ['lastReadMessageId'],
  });
export type ListMessagesQuery = z.infer<typeof ListMessagesQuerySchema>;

export const PageInfoSchema = z.object({
  hasMore: z.boolean(),
  nextCursor: CursorStringSchema.nullable(),
  prevCursor: CursorStringSchema.nullable(),
});
export type PageInfo = z.infer<typeof PageInfoSchema>;

export const ListMessagesResponseSchema = z.object({
  items: z.array(MessageDtoSchema),
  pageInfo: PageInfoSchema,
});
export type ListMessagesResponse = z.infer<typeof ListMessagesResponseSchema>;

// Task-014-B: GET /messages/:id/thread returns this. Replies sorted ASC
// (oldest first) for the side panel — opposite of the main channel list.
export const ListThreadRepliesQuerySchema = z.object({
  cursor: CursorStringSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListThreadRepliesQuery = z.infer<typeof ListThreadRepliesQuerySchema>;

// S36 (FR-TH-18): viewer 의 스레드 읽음 커서. lastReadMessageId 가 있으면
// 프론트가 그 다음 첫 미읽 답글로 초기 스크롤, null 이면 최하단으로 스크롤한다.
export const ThreadReadStateDtoSchema = z.object({
  lastReadMessageId: z.string().uuid().nullable(),
});
export type ThreadReadStateDto = z.infer<typeof ThreadReadStateDtoSchema>;

// FR-TH-08: 스레드 구독 알림 레벨. Prisma ThreadNotificationLevel enum 과 1:1.
// (ListThreadRepliesResponseSchema 가 viewerNotificationLevel 로 참조하므로
// ListThreadRepliesResponseSchema 보다 먼저 선언한다.)
export const ThreadNotificationLevelSchema = z.enum(['ALL', 'MENTIONS', 'OFF']);
export type ThreadNotificationLevel = z.infer<typeof ThreadNotificationLevelSchema>;

export const ListThreadRepliesResponseSchema = z.object({
  root: MessageDtoSchema,
  replies: z.array(MessageDtoSchema),
  // S36 (FR-TH-18): 초기 스크롤 앵커. default 로 forward-compat(구 API 빌드
  // 응답에 필드가 없으면 null = 최하단 스크롤, 기존 S35 동작).
  readState: ThreadReadStateDtoSchema.default({ lastReadMessageId: null }),
  // S38 fix-forward (reviewer MAJOR / FR-TH-08): viewer 의 스레드 알림 레벨.
  // ThreadPanel 의 벨이 이 값으로 seed 한다(종전엔 항상 'ALL' 로 시작해 저장된
  // OFF/MENTIONS 를 무시하는 회귀). 구독 행이 없으면(아직 미구독) null —
  // 프론트는 null 을 기본 'ALL' 로 표시하되 서버에 별도 구독을 만들지 않는다.
  // 구 API 빌드 응답(필드 없음)도 default 로 null = 'ALL' 표시.
  viewerNotificationLevel: ThreadNotificationLevelSchema.nullable().default(null),
  pageInfo: PageInfoSchema,
});
export type ListThreadRepliesResponse = z.infer<typeof ListThreadRepliesResponseSchema>;

// ── S38 (D04 / FR-TH-08/09/10/13) — 스레드 알림 레벨 · Threads 탭 · 잠금 ──────

// FR-TH-08: PATCH /users/me/threads/:parentMessageId/subscription body.
// 구독 없던 사용자도 ALL 로 수동 구독할 수 있다(서버 upsert).
export const SetThreadNotificationLevelRequestSchema = z.object({
  notificationLevel: ThreadNotificationLevelSchema,
});
export type SetThreadNotificationLevelRequest = z.infer<
  typeof SetThreadNotificationLevelRequestSchema
>;

export const SetThreadNotificationLevelResponseSchema = z.object({
  notificationLevel: ThreadNotificationLevelSchema,
});
export type SetThreadNotificationLevelResponse = z.infer<
  typeof SetThreadNotificationLevelResponseSchema
>;

// FR-TH-13: PATCH /messages/:id/thread/lock body. OWNER/ADMIN 만(서버 게이트).
export const SetThreadLockRequestSchema = z.object({
  locked: z.boolean(),
});
export type SetThreadLockRequest = z.infer<typeof SetThreadLockRequestSchema>;

export const SetThreadLockResponseSchema = z.object({
  parentMessageId: z.string().uuid(),
  locked: z.boolean(),
});
export type SetThreadLockResponse = z.infer<typeof SetThreadLockResponseSchema>;

// FR-TH-09: GET /users/me/threads — 내 구독 스레드 목록(Threads 탭) 항목.
export const ThreadListItemSchema = z.object({
  parentMessageId: z.string().uuid(),
  channelId: z.string().uuid(),
  channelName: z.string(),
  // 루트 메시지 평문 excerpt(서버에서 80자 cap).
  excerpt: z.string(),
  // 마지막 답글 시각(ISO). 답글 0개면 null.
  latestReplyAt: z.string().datetime().nullable(),
  // 마지막 답글 작성자 userId. 답글 0개면 null.
  lastReplierId: z.string().uuid().nullable(),
  // 옵션 B 계산값(denormalized 컬럼 없음). 미읽 답글 수.
  unreadCount: z.number().int().nonnegative(),
  notificationLevel: ThreadNotificationLevelSchema,
});
export type ThreadListItem = z.infer<typeof ThreadListItemSchema>;

export const ListMyThreadsResponseSchema = z.object({
  threads: z.array(ThreadListItemSchema),
});
export type ListMyThreadsResponse = z.infer<typeof ListMyThreadsResponseSchema>;

// S30 (FR-S06): 결과 카드의 전/후 컨텍스트 메시지 한 줄.
// `senderName` / `text` 는 권한 재검증을 통과한 경우에만 채워집니다.
// 채널 VIEW_CHANNEL 권한이 없으면 `masked: true` 로 내려보내고 본문 자리에
// "[접근 불가 메시지]" 를 표기합니다(프런트가 회색 placeholder 렌더).
//
// S30 fix-forward (BLOCKER 보안 A1): masked=true 인 컨텍스트는 식별정보를
// 0 으로 만듭니다. 종전엔 본문(text/senderName)만 가리고 `messageId`(인접
// 메시지 PK)와 정확한 `createdAt` 시각을 그대로 내려보내, 권한 없는 채널
// 메시지의 ID·시각이 누출됐습니다. 이제 마스킹 시 둘 다 null 입니다 —
// 그래서 두 필드를 nullable 로 좁힙니다(masked 가 아니면 항상 채워짐).
export const SearchContextMessageSchema = z.object({
  /** 마스킹 시 null — 권한 없는 채널 메시지의 PK 노출 차단(BLOCKER 보안 A1). */
  messageId: z.string().uuid().nullable(),
  senderName: z.string().nullable(),
  /** HTML-escaped plain excerpt (no <mark>). null when masked. */
  text: z.string().nullable(),
  /** 마스킹 시 null — 권한 없는 채널 메시지의 정확한 시각 노출 차단(A1). */
  createdAt: z.string().datetime().nullable(),
  /** 권한 재검증 실패 시 true — 본문은 placeholder 로 대체. */
  masked: z.boolean(),
});
export type SearchContextMessage = z.infer<typeof SearchContextMessageSchema>;

// Task-015-B: message full-text search. Snippet carries `<mark>` HTML
// from Postgres ts_headline; frontends must sanitize with DOMPurify.
export const SearchResultSchema = z.object({
  messageId: z.string().uuid(),
  channelId: z.string().uuid(),
  channelName: z.string(),
  senderId: z.string().uuid(),
  senderName: z.string(),
  createdAt: z.string().datetime(),
  snippet: z.string(),
  rank: z.number(),
  // ── S30 (FR-S06 / FR-S10) — additive optional fields ──────────────────────
  // 기존 search() 응답은 이 필드를 생략하므로 전부 optional. withContext=true
  // 호출 시에만 채워집니다.
  /** FR-S06: 직전 1메시지(회색 컨텍스트). 권한 재검증 적용. */
  contextBefore: SearchContextMessageSchema.nullable().optional(),
  /** FR-S06: 직후 1메시지(회색 컨텍스트). 권한 재검증 적용. */
  contextAfter: SearchContextMessageSchema.nullable().optional(),
  /** FR-S10: 스레드 답글이면 true (parentMessageId != null). */
  inThread: z.boolean().optional(),
  /** FR-S10: 스레드 답글일 때 루트 메시지 본문 excerpt(HTML-escaped). */
  threadRootExcerpt: z.string().nullable().optional(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

export const SearchResponseSchema = z.object({
  results: z.array(SearchResultSchema),
  nextCursor: z.string().nullable(),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

// S29 (FR-S08): 검색 정렬 모드. relevance(ts_rank_cd, 기본) | recent(createdAt DESC).
export const SearchSortSchema = z.enum(['relevance', 'recent']);
export type SearchSort = z.infer<typeof SearchSortSchema>;

// S30 (FR-S07): 서버측 최근 검색어. Redis `search:recent:{userId}` LPUSH 로
// 중복 제거 + 상한 N 유지. 패널 빈 상태에서 노출합니다(PII 는 워크스페이스
// scope 키에 머무름).
export const RecentSearchesResponseSchema = z.object({
  recents: z.array(z.string()),
});
export type RecentSearchesResponse = z.infer<typeof RecentSearchesResponseSchema>;

// S31 (FR-S02): GET /search/suggest 응답 — 수식어 자동완성 후보.
// from:/in: 타이핑 중 워크스페이스 가시 채널명 + 멤버 username prefix-match.
export const SearchSuggestResponseSchema = z.object({
  channels: z.array(z.object({ id: z.string().uuid(), name: z.string() })),
  users: z.array(z.object({ id: z.string().uuid(), username: z.string() })),
});
export type SearchSuggestResponse = z.infer<typeof SearchSuggestResponseSchema>;

// S29 (FR-S05): 검색 수식어(클라이언트 문서용). 쿼리 문자열 안에 인라인으로
// 작성한다 — `from:@user in:#channel has:link|image|file before:YYYY-MM-DD
// after:YYYY-MM-DD during:today|yesterday|week|month|YYYY-MM is:pinned`.
// 서버 파서(search-query.parser)가 권위적 해석을 수행하므로 이 상수는
// UI 힌트/자동완성용 enum 일 뿐이다.
export const SEARCH_HAS_TYPES = ['link', 'image', 'file'] as const;
export type SearchHasType = (typeof SEARCH_HAS_TYPES)[number];
