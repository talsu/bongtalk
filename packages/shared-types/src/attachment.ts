import { z } from 'zod';

/**
 * S54 (D11 / FR-AM-03/04/05/06/27) — 첨부 업로드(presigned 3단계) 계약 + 차단 확장자
 * + MIME 화이트리스트 + rate-limit 상수의 카노니컬 출처.
 *
 * 업로드 흐름(채널 nested):
 *   1. POST /workspaces/:wsId/channels/:chid/attachments/upload-url
 *        → AttachmentUploadSession 생성 + MinIO presigned PUT/POST 발급.
 *   2. (클라가 MinIO 로 직접 업로드)
 *   3. POST /workspaces/:wsId/channels/:chid/attachments/complete
 *        → magic-byte 재검증 + ACL 재검증 + Attachment 승격(세션 close).
 *
 * 기존 /attachments/* (presign-upload / :id/finalize / :id/download-url) 라우트는
 * deprecated 로 유지된다(S55+ 의존·integration 무회귀).
 */

// ── FR-AM-04: 크기·개수 ─────────────────────────────────────────────────────
/** 단일 첨부 최대 크기(100MB). S3Service.maxBytes 와 동일 값(서버가 권위 검증). */
export const ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024;
/** 메시지당 최대 첨부 개수(10). DS 첨부 그리드 최대 노출 수와 정합. */
export const ATTACHMENT_MAX_PER_MESSAGE = 10;

// ── FR-AM-27: upload-url rate limit (사용자당 3종 독립) ──────────────────────
/** 15분 슬라이딩 윈도우 최대 발급 횟수. */
export const UPLOAD_RL_WINDOW_15M_SEC = 15 * 60;
export const UPLOAD_RL_WINDOW_15M_MAX = 60;
/** 1분 슬라이딩 윈도우 최대 발급 횟수(버스트 방어). */
export const UPLOAD_RL_WINDOW_1M_SEC = 60;
export const UPLOAD_RL_WINDOW_1M_MAX = 10;
/** 동시 미완료(completed=false AND expiresAt>now) 세션 최대 개수. */
export const UPLOAD_RL_CONCURRENT_MAX = 20;

// ── FR-AM-03: presigned PUT/POST TTL — 크기 분기(초) ─────────────────────────
/** 기본 TTL(15분). 30MB 미만. */
export const UPLOAD_TTL_DEFAULT_SEC = 15 * 60;
/** 30MB 이상 → 30분. */
export const UPLOAD_TTL_MEDIUM_SEC = 30 * 60;
/** 80MB 이상 → 60분. */
export const UPLOAD_TTL_LARGE_SEC = 60 * 60;
export const UPLOAD_TTL_MEDIUM_THRESHOLD = 30 * 1024 * 1024;
export const UPLOAD_TTL_LARGE_THRESHOLD = 80 * 1024 * 1024;

/**
 * FR-AM-05: 차단 확장자 블랙리스트(소문자, 점 제외). 실행 파일 / 스크립트 / 디스크
 * 이미지 등 위험 확장자를 upload-url 단계에서 거부한다. zip/jar/apk 의 PK 헤더
 * 공유 교차검증은 별도 로직(아래 EXT_FOR_ZIP_LIKE)으로 다룬다.
 */
export const BLOCKED_EXTENSIONS: readonly string[] = [
  'exe',
  'dll',
  'bat',
  'com',
  'msi',
  'vbs',
  'ps1',
  'jar',
  'apk',
  'dmg',
  'ipa',
  'iso',
  'hta',
  'aspx',
  'jsp',
  'scr',
  'pif',
  'cmd',
  'sh',
  'cpl',
];

/**
 * FR-AM-05 교차검증: application/zip 와 PK(0x50 0x4B) 헤더를 공유하는 확장자들.
 * declared mime=application/zip 인데 extension 이 이들 중 하나면(jar/apk 는 실행
 * 가능 아카이브) 차단한다 — zip 으로 위장한 실행 아카이브를 막는다.
 */
export const ZIP_DISGUISE_EXTENSIONS: readonly string[] = ['jar', 'apk', 'ipa'];

/**
 * FR-AM-06: 허용 MIME 화이트리스트 → kind 매핑. SVG 는 기본 차단(목록에 없음 —
 * 스크립트 임베드 XSS 리스크. 허용 시 download/complete 에서 Content-Disposition:
 * attachment + X-Content-Type-Options: nosniff 강제 필요 — S54 는 차단으로 단순화).
 */
export const ALLOWED_MIME_KIND: Record<string, 'IMAGE' | 'VIDEO' | 'FILE'> = {
  // image
  'image/jpeg': 'IMAGE',
  'image/png': 'IMAGE',
  'image/gif': 'IMAGE',
  'image/webp': 'IMAGE',
  'image/avif': 'IMAGE',
  // video
  'video/mp4': 'VIDEO',
  'video/webm': 'VIDEO',
  'video/ogg': 'VIDEO',
  // audio (kind=FILE — 인라인 오디오 플레이어는 후속)
  'audio/mpeg': 'FILE',
  'audio/ogg': 'FILE',
  'audio/wav': 'FILE',
  'audio/flac': 'FILE',
  // documents
  'application/pdf': 'FILE',
  'text/plain': 'FILE',
  'text/csv': 'FILE',
  'text/markdown': 'FILE',
  // office
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'FILE',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'FILE',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'FILE',
  // archives
  'application/zip': 'FILE',
  'application/x-tar': 'FILE',
};

// ── FR-AM-03: POST .../attachments/upload-url ───────────────────────────────
export const UploadUrlRequestSchema = z.object({
  filename: z.string().min(1).max(255),
  size: z.number().int().positive().max(ATTACHMENT_MAX_BYTES),
  mimeType: z.string().min(1).max(127),
  // 한 번에 발급할 세션 수(다중 첨부 일괄 업로드). 기본 1, 메시지당 상한과 별개로
  // upload-url 호출당 ≤10.
  count: z.number().int().min(1).max(ATTACHMENT_MAX_PER_MESSAGE).default(1),
});
export type UploadUrlRequest = z.infer<typeof UploadUrlRequestSchema>;

// MinIO presigned POST 폼 필드(createPresignedPost 산출). PutObjectCommand presign
// 폴백 시 method='PUT' + putUrl 만 채워질 수 있다(편차 기록).
export const PresignedPostSchema = z.object({
  // 'POST'(createPresignedPost) | 'PUT'(presignPut 폴백).
  method: z.enum(['POST', 'PUT']),
  // POST: 폼 action URL. PUT: 직접 PUT 대상 URL.
  url: z.string(),
  // POST 일 때만: 폼 hidden 필드(key, policy, signature 등). PUT 이면 {}.
  fields: z.record(z.string()).default({}),
});
export type PresignedPost = z.infer<typeof PresignedPostSchema>;

export const UploadSessionSchema = z.object({
  sessionId: z.string().uuid(),
  storageKey: z.string(),
  expiresAt: z.string().datetime(),
  upload: PresignedPostSchema,
});
export type UploadSession = z.infer<typeof UploadSessionSchema>;

export const UploadUrlResponseSchema = z.object({
  sessions: z.array(UploadSessionSchema),
});
export type UploadUrlResponse = z.infer<typeof UploadUrlResponseSchema>;

// ── FR-AM-03: POST .../attachments/complete ─────────────────────────────────
export const CompleteSessionItemSchema = z.object({
  sessionId: z.string().uuid(),
  width: z.number().int().positive().max(100_000).optional(),
  height: z.number().int().positive().max(100_000).optional(),
  duration: z.number().nonnegative().max(86_400).optional(),
  altText: z.string().max(2000).optional(),
  isSpoiler: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
});
export type CompleteSessionItem = z.infer<typeof CompleteSessionItemSchema>;

export const CompleteUploadRequestSchema = z
  .object({
    // messageId | targetChannelId 택1 필수. messageId 면 기존 메시지에 첨부 링크,
    // targetChannelId 면 곧 보낼 메시지용 pre-link(SendMessage 의 attachmentIds 로 참조).
    messageId: z.string().uuid().optional(),
    targetChannelId: z.string().uuid().optional(),
    sessions: z.array(CompleteSessionItemSchema).min(1).max(ATTACHMENT_MAX_PER_MESSAGE),
  })
  .refine((b) => (b.messageId ? 1 : 0) + (b.targetChannelId ? 1 : 0) === 1, {
    message: 'exactly one of messageId | targetChannelId is required',
    path: ['messageId'],
  });
export type CompleteUploadRequest = z.infer<typeof CompleteUploadRequestSchema>;

// ── FR-RS-13: 메시지 읽음 처리 모드 ─────────────────────────────────────────
export const MarkAsReadModeSchema = z.enum([
  'AUTO_FROM_POSITION',
  'AUTO_FROM_LATEST',
  'MANUAL_FROM_LATEST',
]);
export type MarkAsReadMode = z.infer<typeof MarkAsReadModeSchema>;

// PATCH /users/me/settings (+ deprecated alias PATCH /users/me/preferences) body.
export const UpdateUserSettingsRequestSchema = z
  .object({
    markAsReadMode: MarkAsReadModeSchema,
  })
  .strict();
export type UpdateUserSettingsRequest = z.infer<typeof UpdateUserSettingsRequestSchema>;

export const UserSettingsResponseSchema = z.object({
  markAsReadMode: MarkAsReadModeSchema,
});
export type UserSettingsResponse = z.infer<typeof UserSettingsResponseSchema>;
