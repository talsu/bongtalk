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
 * 기본값: theme=DARK · density=COZY · chatFontSize=15 · clock24h=false.
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
  clock24h: false,
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
