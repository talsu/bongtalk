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
 *   - timezone:    IANA tz 문자열(≤64자).
 *   - bio:         ≤190자(About Me · PRD). DB VarChar 제약은 변경하지 않고
 *                  앱 레이어에서만 190 으로 강제한다(기존 500자 데이터 truncate 회피).
 *
 * 워크스페이스별 프로필(FR-PS-06)·배너(FR-PS-04)는 S74+ 범위(OUT).
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
// FR-PS-02: About Me 190자(PRD D14). DB 컬럼(VarChar 500)은 변경하지 않는다.
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
    timezone: z.string().max(TIMEZONE_MAX).nullable(),
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

/** POST /me/avatar/presign 응답. */
export const AvatarPresignResultSchema = z.object({
  key: z.string(),
  putUrl: z.string(),
  expiresAt: z.string().datetime(),
});
export type AvatarPresignResult = z.infer<typeof AvatarPresignResultSchema>;

/** PUT /me/avatar 요청(presign 으로 받은 key 확정). */
export const AvatarFinalizeInputSchema = z
  .object({
    key: z.string().min(1),
  })
  .strict();
export type AvatarFinalizeInput = z.infer<typeof AvatarFinalizeInputSchema>;

/** PUT /me/avatar 응답. */
export const AvatarFinalizeResultSchema = z.object({
  avatarUrl: z.string(),
});
export type AvatarFinalizeResult = z.infer<typeof AvatarFinalizeResultSchema>;
