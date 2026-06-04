import { z } from 'zod';

/**
 * S73 (D14 / FR-PS-01·02·03): 전역 프로필 + 아바타 컨트랙트.
 *
 * 두 레이어 신원(PRD §D14) 중 이 슬라이스가 다루는 전역 레이어:
 *   - handle:      소문자·숫자·`_`·`.` 의 3–32자 전역 유일 식별자(@멘션 타겟).
 *                  마지막 변경 + 30일 쿨다운(FR-PS-03).
 *   - displayName: 1–80자 비유니크 자유 문자열.
 *   - fullName:    ≤50자.
 *   - pronouns:    ≤40자.
 *   - title:       ≤80자.
 *   - timezone:    IANA tz 문자열(≤64자 · `Area/Location` 형태).
 *   - bio:         ≤190자(About Me · PRD). DB 컬럼은 TEXT(무제한) 이므로 길이 제약은
 *                  앱 레이어에서만 190 으로 강제한다(기존 ≥191자 데이터 truncate 회피).
 *
 * S74 (D14 / FR-PS-04·06): 프로필 배너(FR-PS-04) + 워크스페이스별 프로필(FR-PS-06)
 * 컨트랙트를 같은 파일에 더한다(전역 프로필과 한 도메인 — Zod 단일 출처).
 */

// FR-PS-02: 핸들 형식 — 소문자/숫자/언더스코어/점, 3–32자.
export const HANDLE_RE = /^[a-z0-9_.]{3,32}$/;
export const HANDLE_MIN = 3;
export const HANDLE_MAX = 32;
export const DISPLAY_NAME_MAX = 80;
export const FULL_NAME_MAX = 50;
export const PRONOUNS_MAX = 40;
export const TITLE_MAX = 80;
export const TIMEZONE_MAX = 64;
// FR-PS-02: IANA timezone 형태(`Area/Location` — 예 Asia/Seoul, America/Argentina/Buenos_Aires).
// 전체 tz 데이터셋 검증은 아니지만 임의 문자열/주입을 차단한다(빈 문자열·null 은 정규화 단에서 허용).
export const TIMEZONE_RE = /^[A-Za-z]+\/[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)*$/;
// FR-PS-02: About Me 190자(PRD D14). DB 컬럼은 TEXT 라 무제한이지만 앱 레이어에서 190 으로 강제한다.
export const BIO_MAX = 190;

// FR-PS-03: 핸들 변경 쿨다운(일).
export const HANDLE_COOLDOWN_DAYS = 30;

// FR-PS-01: 아바타 업로드 제약.
export const AVATAR_MAX_BYTES = 8 * 1024 * 1024; // 8 MB
export const AVATAR_ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type AvatarMime = (typeof AVATAR_ALLOWED_MIME)[number];

/**
 * 프로필 외부 링크(task-047 M2 carryover). S73 은 링크 편집 UI 를 새로 만들지 않지만,
 * 기존 `/me/profile` 응답이 links 를 포함하므로 무회귀를 위해 응답 shape 에 보존한다.
 */
export const ProfileLinkSchema = z.object({
  url: z.string(),
  label: z.string().optional(),
});
export type ProfileLink = z.infer<typeof ProfileLinkSchema>;

/** GET /me/profile 응답. */
export const ProfileViewSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  username: z.string(),
  // FR-PS-02: handle 은 username 폴백(Option B). 백필 후엔 항상 채워진다.
  handle: z.string().nullable(),
  displayName: z.string().nullable(),
  fullName: z.string().nullable(),
  pronouns: z.string().nullable(),
  title: z.string().nullable(),
  timezone: z.string().nullable(),
  bio: z.string().nullable(),
  // FR-PS-03: 클라이언트가 "다음 변경 가능일 D-N" 을 계산하는 기준(ISO 또는 null).
  handleChangedAt: z.string().datetime().nullable(),
  // FR-PS-01: presigned GET URL(null = 미설정).
  avatarUrl: z.string().nullable(),
  // FR-PS-04 (S74): 배너 presigned GET URL(null = 미설정).
  bannerUrl: z.string().nullable(),
  // FR-PS-05 (S74 · Fork1 Option C): 커스텀상태 만료 시 DND 동시 활성화 옵션.
  dndDuringStatus: z.boolean(),
  customStatus: z.string().nullable(),
  // task-047 M2 carryover(무회귀): 기존 프로필 링크. S73 은 신규 편집 UI 미포함.
  links: z.array(ProfileLinkSchema).nullable(),
});
export type ProfileView = z.infer<typeof ProfileViewSchema>;

// task-047 M2 carryover: 프로필 링크 제약(무회귀). 최대 3개·url 은 http(s)·label ≤32자.
export const PROFILE_LINKS_MAX = 3;
export const PROFILE_LINK_URL_MAX = 2048;
export const PROFILE_LINK_LABEL_MAX = 32;

export const UpdateProfileLinkSchema = z.object({
  url: z
    .string()
    .min(1)
    .max(PROFILE_LINK_URL_MAX)
    .regex(/^https?:\/\//i, 'url must start with http:// or https://'),
  label: z.string().max(PROFILE_LINK_LABEL_MAX).optional(),
});

/**
 * PATCH /me/profile 요청. 모든 필드 optional(부분 업데이트). 명시되지 않은 필드는
 * 변경하지 않는다. null 은 명시적 비우기(handle 은 비울 수 없음 — 항상 값 유지).
 */
export const UpdateProfileInputSchema = z
  .object({
    handle: z.string().regex(HANDLE_RE),
    displayName: z.string().min(1).max(DISPLAY_NAME_MAX).nullable(),
    fullName: z.string().max(FULL_NAME_MAX).nullable(),
    pronouns: z.string().max(PRONOUNS_MAX).nullable(),
    title: z.string().max(TITLE_MAX).nullable(),
    // FR-PS-02: 빈 문자열/null 은 "비우기"로 허용하고, 값이 있으면 IANA tz 형태만 통과시킨다.
    timezone: z.union([z.literal(''), z.string().max(TIMEZONE_MAX).regex(TIMEZONE_RE)]).nullable(),
    bio: z.string().max(BIO_MAX).nullable(),
    // task-047 M2 carryover(무회귀): 기존 프로필 링크 편집. cap 3.
    links: z.array(UpdateProfileLinkSchema).max(PROFILE_LINKS_MAX).nullable(),
  })
  .partial()
  .strict();
export type UpdateProfileInput = z.infer<typeof UpdateProfileInputSchema>;

/** POST /me/avatar/presign 요청. */
export const AvatarPresignInputSchema = z
  .object({
    contentType: z.enum(AVATAR_ALLOWED_MIME),
    sizeBytes: z.number().int().positive().max(AVATAR_MAX_BYTES),
  })
  .strict();
export type AvatarPresignInput = z.infer<typeof AvatarPresignInputSchema>;

// FR-PS-01 (security HIGH#1): 아바타 키는 `avatars/<userId>/<file>` 3-세그먼트 형태만
// 허용한다. 파일 세그먼트는 `..`·`/` 를 포함할 수 없어 디렉터리 traversal·키 변조를 차단한다
// (서비스는 추가로 prefix + `..` 포함 여부를 재검증한다).
export const AVATAR_KEY_RE = /^avatars\/[^/]+\/[A-Za-z0-9_.-]+$/;

/**
 * POST /me/avatar/presign 응답.
 *
 * security HIGH#2: presigned PUT 은 클라가 임의 바이트/Content-Type 을 올릴 수 있어
 * MinIO 가 업로드 시점에 크기/MIME 를 강제하지 못한다. presigned POST(content-length-range
 * + eq Content-Type 정책 조건 — S54 첨부 패턴)로 전환해 MinIO 가 업로드 시점에 거부하게 한다.
 * 클라는 fields 를 multipart form 으로 보낸 뒤 file 을 마지막에 append 한다.
 */
export const AvatarPresignResultSchema = z.object({
  key: z.string(),
  // multipart form action URL(MinIO presigned POST).
  url: z.string(),
  // presigned POST 폼 hidden 필드(key/policy/signature/Content-Type 등).
  fields: z.record(z.string()).default({}),
  expiresAt: z.string().datetime(),
});
export type AvatarPresignResult = z.infer<typeof AvatarPresignResultSchema>;

/** PUT /me/avatar 요청(presign 으로 받은 key 확정). */
export const AvatarFinalizeInputSchema = z
  .object({
    // security HIGH#1: traversal 차단 — `avatars/<seg>/<file>` 형태만.
    key: z.string().min(1).max(512).regex(AVATAR_KEY_RE),
  })
  .strict();
export type AvatarFinalizeInput = z.infer<typeof AvatarFinalizeInputSchema>;

/** PUT /me/avatar 응답. */
export const AvatarFinalizeResultSchema = z.object({
  avatarUrl: z.string(),
});
export type AvatarFinalizeResult = z.infer<typeof AvatarFinalizeResultSchema>;

// ─────────────────────── S74 (D14 / FR-PS-04) 프로필 배너 ───────────────────

/**
 * FR-PS-04: 배너 업로드 제약. 680×240px 이상·≤8MB. 픽셀 치수 검증은 클라(렌더 미리보기)
 * 책임이고 서버는 MIME/크기/magic-byte 만 강제한다(서버 이미지 디코드 없음 —
 * [[feedback_no_server_media_resize]]). MIME 은 아바타와 동일(png/jpeg/webp).
 */
export const BANNER_MAX_BYTES = 8 * 1024 * 1024; // 8 MB
export const BANNER_ALLOWED_MIME = AVATAR_ALLOWED_MIME;
export type BannerMime = (typeof BANNER_ALLOWED_MIME)[number];
// FR-PS-04 (security): 클라 미리보기 권장 최소 치수(서버 미검증·UI 안내용).
export const BANNER_MIN_WIDTH = 680;
export const BANNER_MIN_HEIGHT = 240;

// FR-PS-04 (security HIGH#1): 배너 키는 `banners/<userId>/<file>` 3-세그먼트 형태만
// 허용한다(아바타 AVATAR_KEY_RE 와 동일 traversal 차단 — `..`·`/` 불허).
export const BANNER_KEY_RE = /^banners\/[^/]+\/[A-Za-z0-9_.-]+$/;

/** POST /me/banner/presign 요청. */
export const BannerPresignInputSchema = z
  .object({
    contentType: z.enum(BANNER_ALLOWED_MIME),
    sizeBytes: z.number().int().positive().max(BANNER_MAX_BYTES),
  })
  .strict();
export type BannerPresignInput = z.infer<typeof BannerPresignInputSchema>;

/** POST /me/banner/presign 응답(presigned POST — 아바타와 동일 패턴). */
export const BannerPresignResultSchema = z.object({
  key: z.string(),
  url: z.string(),
  fields: z.record(z.string()).default({}),
  expiresAt: z.string().datetime(),
});
export type BannerPresignResult = z.infer<typeof BannerPresignResultSchema>;

/** PUT /me/banner 요청(presign 으로 받은 key 확정). */
export const BannerFinalizeInputSchema = z
  .object({
    key: z.string().min(1).max(512).regex(BANNER_KEY_RE),
  })
  .strict();
export type BannerFinalizeInput = z.infer<typeof BannerFinalizeInputSchema>;

/** PUT /me/banner 응답. */
export const BannerFinalizeResultSchema = z.object({
  bannerUrl: z.string(),
});
export type BannerFinalizeResult = z.infer<typeof BannerFinalizeResultSchema>;

// ──────────────── S74 (D14 / FR-PS-06) 워크스페이스별 프로필 ─────────────────

/** FR-PS-06: 워크스페이스 닉네임/About Me 길이 한도. */
export const WS_NICKNAME_MAX = 32;
export const WS_BIO_MAX = 190;

export const WS_AVATAR_MAX_BYTES = 8 * 1024 * 1024; // 8 MB
export const WS_AVATAR_ALLOWED_MIME = AVATAR_ALLOWED_MIME;
export type WsAvatarMime = (typeof WS_AVATAR_ALLOWED_MIME)[number];

// FR-PS-06 (security HIGH#1): ws아바타 키는 `ws-avatars/<wsId>/<userId>/<file>`
// 4-세그먼트 형태만 허용한다(traversal 차단 — `..`·`/` 불허).
export const WS_AVATAR_KEY_RE = /^ws-avatars\/[^/]+\/[^/]+\/[A-Za-z0-9_.-]+$/;

/**
 * GET /workspaces/:wsId/me/profile 및 /workspaces/:wsId/members/:userId/profile 응답.
 * 행 부재(오버라이드 없음) 시에도 nickname/avatarUrl/workspaceBio 가 모두 null 인 shape 로
 * 응답한다(클라가 폼을 빈 값으로 안전 초기화).
 */
export const WorkspaceMemberProfileViewSchema = z.object({
  workspaceId: z.string().uuid(),
  userId: z.string().uuid(),
  nickname: z.string().nullable(),
  // presigned GET URL(null = ws아바타 미설정 → 전역/기본 폴백).
  avatarUrl: z.string().nullable(),
  workspaceBio: z.string().nullable(),
});
export type WorkspaceMemberProfileView = z.infer<typeof WorkspaceMemberProfileViewSchema>;

/**
 * PATCH /workspaces/:wsId/me/profile 요청. 부분 갱신(명시 필드만). null = 명시적 비우기
 * (해당 필드를 전역값 폴백으로 되돌림). avatarKey 는 별도 presign/finalize 경로라 여기엔 없다.
 */
export const UpdateWorkspaceMemberProfileInputSchema = z
  .object({
    nickname: z.string().min(1).max(WS_NICKNAME_MAX).nullable(),
    workspaceBio: z.string().max(WS_BIO_MAX).nullable(),
  })
  .partial()
  .strict();
export type UpdateWorkspaceMemberProfileInput = z.infer<
  typeof UpdateWorkspaceMemberProfileInputSchema
>;

/** POST /workspaces/:wsId/me/profile/avatar/presign 요청. */
export const WsAvatarPresignInputSchema = z
  .object({
    contentType: z.enum(WS_AVATAR_ALLOWED_MIME),
    sizeBytes: z.number().int().positive().max(WS_AVATAR_MAX_BYTES),
  })
  .strict();
export type WsAvatarPresignInput = z.infer<typeof WsAvatarPresignInputSchema>;

/** POST /workspaces/:wsId/me/profile/avatar/presign 응답(presigned POST). */
export const WsAvatarPresignResultSchema = z.object({
  key: z.string(),
  url: z.string(),
  fields: z.record(z.string()).default({}),
  expiresAt: z.string().datetime(),
});
export type WsAvatarPresignResult = z.infer<typeof WsAvatarPresignResultSchema>;

/** PUT /workspaces/:wsId/me/profile/avatar 요청. */
export const WsAvatarFinalizeInputSchema = z
  .object({
    key: z.string().min(1).max(512).regex(WS_AVATAR_KEY_RE),
  })
  .strict();
export type WsAvatarFinalizeInput = z.infer<typeof WsAvatarFinalizeInputSchema>;

/** PUT /workspaces/:wsId/me/profile/avatar 응답. */
export const WsAvatarFinalizeResultSchema = z.object({
  avatarUrl: z.string(),
});
export type WsAvatarFinalizeResult = z.infer<typeof WsAvatarFinalizeResultSchema>;
