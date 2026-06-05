import { describe, expect, it } from 'vitest';
import { shouldSuppressNotificationToast } from './notificationDndGate';

describe('S76 notification DND gate (FR-PS-11)', () => {
  it('suppresses when effective preference is dnd (manual or schedule-active)', () => {
    expect(shouldSuppressNotificationToast('dnd')).toBe(true);
  });

  it('does not suppress under normal (auto) presence', () => {
    expect(shouldSuppressNotificationToast('auto')).toBe(false);
  });

  it('does not suppress for invisible presence (it is not DND)', () => {
    expect(shouldSuppressNotificationToast('invisible')).toBe(false);
  });

  it('does not suppress when preference is unknown (null/undefined — conservative pass-through)', () => {
    expect(shouldSuppressNotificationToast(null)).toBe(false);
    expect(shouldSuppressNotificationToast(undefined)).toBe(false);
  });
});
