import { z } from 'zod';

/**
 * S76 (D14 / FR-PS-09 + FR-PS-18): 외관 설정 컨트랙트.
 *
 * 테마(DARK/LIGHT/SYSTEM) · 메시지 밀도(COZY/COMPACT) · 채팅 폰트 크기(6단계)
 * · 24시간 시계(boolean) 를 한 묶음으로 다룬다. 서버가 단일 출처이며(UserSettings
 * 신규 컬럼) 클라이언트는 GET 으로 보정하고 PATCH 로 즉시 자동 저장한다(Fork B1).
 *
 *   GET   /me/settings/appearance  → AppearanceSettings (행 없으면 기본값).
 *   PATCH /me/settings/appearance  → UpdateAppearanceSettings (.partial().strict()).
 *
 * 기본값: theme=DARK · density=COZY · chatFontSize=15 · clock24h=true.
 *
 * S76 fix-forward (F-B2): clock24h 기본값은 true(24시간제)다. 기존 전체 사용자는
 * formatMessageTime 의 24시간제 기본 동작을 보고 있었으므로(한국어 관례 + spec 단언),
 * S76 이 default 를 false 로 도입하면 기존 사용자가 무단으로 12시간제로 회귀한다.
 * shared-types 기본값 · Prisma 컬럼 DEFAULT · store · MessageItem 폴백을 모두 true 로
 * 통일해 기존 동작을 보존한다(미배포 마이그레이션이라 컬럼 DEFAULT 편집 가능).
 */

// 테마 — DS data-theme 토큰과 대응(SYSTEM 은 클라가 prefers-color-scheme 로 해석).
export const ThemeSchema = z.enum(['DARK', 'LIGHT', 'SYSTEM']);
export type Theme = z.infer<typeof ThemeSchema>;

// 메시지 밀도 — DS [data-density="compact"] 셀렉터와 대응(COZY=기본 비-compact).
export const DensitySchema = z.enum(['COZY', 'COMPACT']);
export type Density = z.infer<typeof DensitySchema>;

/**
 * 채팅 폰트 크기 6단계(px). DS `--fs-chat` 변수로 배선한다. union 으로 제한해
 * 서버/클라/슬라이더가 동일 6값만 허용한다(임의 값 거부 → 400).
 */
export const CHAT_FONT_SIZES = [12, 13, 14, 15, 16, 18] as const;
export const ChatFontSizeSchema = z.union([
  z.literal(12),
  z.literal(13),
  z.literal(14),
  z.literal(15),
  z.literal(16),
  z.literal(18),
]);
export type ChatFontSize = z.infer<typeof ChatFontSizeSchema>;

// FR-PS-09 기본값(서버 컬럼 default 와 1:1 — 행 부재 시 폴백에도 동일하게 적용).
export const DEFAULT_APPEARANCE: AppearanceSettings = {
  theme: 'DARK',
  density: 'COZY',
  chatFontSize: 15,
  // F-B2: 24시간제가 기존(회귀 방지) 기본값. formatMessageTime 도 기본 true.
  clock24h: true,
};

export const AppearanceSettingsSchema = z.object({
  theme: ThemeSchema,
  density: DensitySchema,
  chatFontSize: ChatFontSizeSchema,
  clock24h: z.boolean(),
});
export type AppearanceSettings = z.infer<typeof AppearanceSettingsSchema>;

// PATCH 부분 갱신 — 전달된 필드만 갱신. strict 로 비-화이트리스트 필드 거부.
export const UpdateAppearanceSettingsSchema = AppearanceSettingsSchema.partial().strict();
export type UpdateAppearanceSettings = z.infer<typeof UpdateAppearanceSettingsSchema>;

/**
 * S77a (D14 / FR-PS-12): 접근성 설정 컨트랙트.
 *
 * `reduceMotion` · `highContrast` 두 boolean 을 한 묶음으로 다룬다. 외관 설정과 동일하게
 * 서버(UserSettings 신규 컬럼)가 단일 출처이며, 클라이언트는 GET 으로 보정하고 PATCH 로
 * 즉시 자동 저장한다(appearance 패턴 mirror).
 *
 *   GET   /me/settings/accessibility  → AccessibilitySettings (행 없으면 기본값).
 *   PATCH /me/settings/accessibility  → UpdateAccessibilitySettings (.partial().strict()).
 *
 * 기본값(서버 컬럼 default 와 1:1): reduceMotion=false · highContrast=false.
 *
 * ★ 서버값은 단일 출처지만, 설정 레코드가 없을 때는 클라가 OS `prefers-reduced-motion`
 * 미디어쿼리를 기본으로 반영한다(FR-PS-12). 서버에 값이 저장되면 그 값이 미디어쿼리를
 * 덮어쓰는 단일 출처가 된다 — 즉 `false` 기본은 "사용자가 명시 설정하지 않음" 을 뜻하며,
 * app CSS 의 `@media (prefers-reduced-motion: reduce)` 가 그 경우의 OS 우선 동작을 담당한다.
 */
export const DEFAULT_ACCESSIBILITY: AccessibilitySettings = {
  reduceMotion: false,
  highContrast: false,
};

export const AccessibilitySettingsSchema = z.object({
  reduceMotion: z.boolean(),
  highContrast: z.boolean(),
});
export type AccessibilitySettings = z.infer<typeof AccessibilitySettingsSchema>;

export const UpdateAccessibilitySettingsSchema = AccessibilitySettingsSchema.partial().strict();
export type UpdateAccessibilitySettings = z.infer<typeof UpdateAccessibilitySettingsSchema>;

/**
 * S77a (D14 / FR-PS-13): 친구 요청 수신 정책.
 *
 *   EVERYONE          — 누구나 친구 요청 가능(기본).
 *   MUTUAL_WORKSPACE  — 공통 워크스페이스 멤버만 친구 요청 가능.
 *   NOBODY            — 친구 요청 수신 차단.
 *
 * Prisma `FriendReqPolicy` enum 및 class-validator 화이트리스트와 1:1 정합한다. 게이트는
 * 친구 요청 생성(FriendsService.requestByUsername) 에서 **대상의** 정책을 확인한다.
 */
export const FriendReqPolicySchema = z.enum(['EVERYONE', 'MUTUAL_WORKSPACE', 'NOBODY']);
export type FriendReqPolicy = z.infer<typeof FriendReqPolicySchema>;

/**
 * S77a (D14 / FR-PS-13): 프라이버시 설정 컨트랙트.
 *
 * `allowDmFromWorkspaceMembers`(워크스페이스 멤버발 DM 허용) · `messageRequestEnabled`
 * (메시지 요청 수신 허용) · `allowFriendRequests`(친구 요청 정책) 세 값을 묶는다. 서버가
 * 단일 출처(UserSettings 신규 컬럼)이며 PATCH 로 즉시 자동 저장한다(appearance 패턴).
 *
 *   GET   /me/settings/privacy  → PrivacySettings (행 없으면 기본값).
 *   PATCH /me/settings/privacy  → UpdatePrivacySettings (.partial().strict()).
 *
 * 기본값(서버 컬럼 default 와 1:1):
 *   allowDmFromWorkspaceMembers=true · messageRequestEnabled=true · allowFriendRequests=EVERYONE.
 *
 * ★ 게이트 enforcement(죽은 컨트롤 금지):
 *   - allowDmFromWorkspaceMembers → DM 수신권한 게이트(assertDmPrivacyAllows)에 배선 —
 *     공통 워크스페이스만으로 허용되던 DM 을 false 면 차단(친구는 계속 허용·차단 우선).
 *   - allowFriendRequests        → 친구 요청 생성 게이트(requestByUsername)에 배선 —
 *     NOBODY 거부 / MUTUAL_WORKSPACE 공통 ws 멤버만 / EVERYONE 허용.
 *   - messageRequestEnabled      → 본 슬라이스 기준 message-request 인프라가 코드에
 *     존재하지 않으므로 컬럼 저장 + 정직한 UI 라벨만 둔다(carryover — 인프라 도입 시 배선).
 */
export const DEFAULT_PRIVACY: PrivacySettings = {
  allowDmFromWorkspaceMembers: true,
  messageRequestEnabled: true,
  allowFriendRequests: 'EVERYONE',
};

export const PrivacySettingsSchema = z.object({
  allowDmFromWorkspaceMembers: z.boolean(),
  messageRequestEnabled: z.boolean(),
  allowFriendRequests: FriendReqPolicySchema,
});
export type PrivacySettings = z.infer<typeof PrivacySettingsSchema>;

export const UpdatePrivacySettingsSchema = PrivacySettingsSchema.partial().strict();
export type UpdatePrivacySettings = z.infer<typeof UpdatePrivacySettingsSchema>;
