import { describe, expect, it } from 'vitest';
import {
  AccessibilitySettingsSchema,
  AppearanceSettingsSchema,
  CHAT_FONT_SIZES,
  ChatFontSizeSchema,
  DEFAULT_ACCESSIBILITY,
  DEFAULT_APPEARANCE,
  DEFAULT_PRIVACY,
  DensitySchema,
  FriendReqPolicySchema,
  PrivacySettingsSchema,
  ThemeSchema,
  UpdateAccessibilitySettingsSchema,
  UpdateAppearanceSettingsSchema,
  UpdatePrivacySettingsSchema,
} from './settings';

describe('S76 settings (FR-PS-09) Zod', () => {
  it('accepts the canonical default appearance', () => {
    const parsed = AppearanceSettingsSchema.safeParse(DEFAULT_APPEARANCE);
    expect(parsed.success).toBe(true);
  });

  it('default is theme=DARK, density=COZY, chatFontSize=15, clock24h=true (F-B2 회귀 방지)', () => {
    expect(DEFAULT_APPEARANCE).toEqual({
      theme: 'DARK',
      density: 'COZY',
      chatFontSize: 15,
      // F-B2: 24시간제가 기존 동작 — 기본 true 로 보존(formatMessageTime 기본 true 와 정합).
      clock24h: true,
    });
  });

  it('Theme enum is DARK/LIGHT/SYSTEM only', () => {
    expect(ThemeSchema.safeParse('DARK').success).toBe(true);
    expect(ThemeSchema.safeParse('LIGHT').success).toBe(true);
    expect(ThemeSchema.safeParse('SYSTEM').success).toBe(true);
    expect(ThemeSchema.safeParse('AMOLED').success).toBe(false);
  });

  it('Density enum is COZY/COMPACT only', () => {
    expect(DensitySchema.safeParse('COZY').success).toBe(true);
    expect(DensitySchema.safeParse('COMPACT').success).toBe(true);
    expect(DensitySchema.safeParse('SPACIOUS').success).toBe(false);
  });

  it('chatFontSize accepts exactly the 6 allowed steps', () => {
    for (const size of CHAT_FONT_SIZES) {
      expect(ChatFontSizeSchema.safeParse(size).success).toBe(true);
    }
    expect(CHAT_FONT_SIZES).toEqual([12, 13, 14, 15, 16, 18]);
  });

  it('chatFontSize rejects out-of-range / off-step values', () => {
    expect(ChatFontSizeSchema.safeParse(11).success).toBe(false);
    expect(ChatFontSizeSchema.safeParse(17).success).toBe(false);
    expect(ChatFontSizeSchema.safeParse(20).success).toBe(false);
    expect(ChatFontSizeSchema.safeParse('15').success).toBe(false);
  });

  it('Update schema is partial — empty object is valid', () => {
    expect(UpdateAppearanceSettingsSchema.safeParse({}).success).toBe(true);
    expect(UpdateAppearanceSettingsSchema.safeParse({ theme: 'LIGHT' }).success).toBe(true);
  });

  it('Update schema is strict — unknown keys are rejected', () => {
    expect(UpdateAppearanceSettingsSchema.safeParse({ theme: 'DARK', bogus: 1 }).success).toBe(
      false,
    );
  });

  it('Update schema rejects an invalid chatFontSize', () => {
    expect(UpdateAppearanceSettingsSchema.safeParse({ chatFontSize: 17 }).success).toBe(false);
  });
});

describe('S77a accessibility (FR-PS-12) Zod', () => {
  it('accepts the canonical default accessibility', () => {
    expect(AccessibilitySettingsSchema.safeParse(DEFAULT_ACCESSIBILITY).success).toBe(true);
  });

  it('default is reduceMotion=false, highContrast=false', () => {
    expect(DEFAULT_ACCESSIBILITY).toEqual({ reduceMotion: false, highContrast: false });
  });

  it('rejects non-boolean values', () => {
    expect(
      AccessibilitySettingsSchema.safeParse({ reduceMotion: 'yes', highContrast: false }).success,
    ).toBe(false);
  });

  it('Update schema is partial — empty object is valid', () => {
    expect(UpdateAccessibilitySettingsSchema.safeParse({}).success).toBe(true);
    expect(UpdateAccessibilitySettingsSchema.safeParse({ reduceMotion: true }).success).toBe(true);
  });

  it('Update schema is strict — unknown keys are rejected', () => {
    expect(
      UpdateAccessibilitySettingsSchema.safeParse({ reduceMotion: true, bogus: 1 }).success,
    ).toBe(false);
  });
});

describe('S77a privacy (FR-PS-13) Zod', () => {
  it('accepts the canonical default privacy', () => {
    expect(PrivacySettingsSchema.safeParse(DEFAULT_PRIVACY).success).toBe(true);
  });

  it('default is allowDm=true, messageRequest=true, allowFriendRequests=EVERYONE', () => {
    expect(DEFAULT_PRIVACY).toEqual({
      allowDmFromWorkspaceMembers: true,
      messageRequestEnabled: true,
      allowFriendRequests: 'EVERYONE',
    });
  });

  it('FriendReqPolicy enum is EVERYONE/MUTUAL_WORKSPACE/NOBODY only', () => {
    expect(FriendReqPolicySchema.safeParse('EVERYONE').success).toBe(true);
    expect(FriendReqPolicySchema.safeParse('MUTUAL_WORKSPACE').success).toBe(true);
    expect(FriendReqPolicySchema.safeParse('NOBODY').success).toBe(true);
    expect(FriendReqPolicySchema.safeParse('FRIENDS').success).toBe(false);
  });

  it('Update schema is partial + strict', () => {
    expect(UpdatePrivacySettingsSchema.safeParse({}).success).toBe(true);
    expect(UpdatePrivacySettingsSchema.safeParse({ allowFriendRequests: 'NOBODY' }).success).toBe(
      true,
    );
    expect(UpdatePrivacySettingsSchema.safeParse({ bogus: 1 }).success).toBe(false);
  });

  it('Update schema rejects an invalid allowFriendRequests', () => {
    expect(UpdatePrivacySettingsSchema.safeParse({ allowFriendRequests: 'WHATEVER' }).success).toBe(
      false,
    );
  });
});
