import { describe, expect, it } from 'vitest';
import {
  PUSH_ENDPOINT_MAX,
  PushSubscriptionRequestSchema,
  PushUnsubscribeRequestSchema,
  VapidPublicKeyResponseSchema,
} from './push';
import { ErrorCodeSchema } from './index';

const validSub = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
  keys: { p256dh: 'BPublicKeyBase64Url', auth: 'AuthSecretBase64Url' },
};

describe('PushSubscriptionRequestSchema', () => {
  it('accepts a well-formed subscription', () => {
    const parsed = PushSubscriptionRequestSchema.safeParse(validSub);
    expect(parsed.success).toBe(true);
  });

  it('rejects a non-URL endpoint', () => {
    const parsed = PushSubscriptionRequestSchema.safeParse({ ...validSub, endpoint: 'not-a-url' });
    expect(parsed.success).toBe(false);
  });

  it('rejects an over-long endpoint', () => {
    const long = `https://push.example.com/${'a'.repeat(PUSH_ENDPOINT_MAX)}`;
    const parsed = PushSubscriptionRequestSchema.safeParse({ ...validSub, endpoint: long });
    expect(parsed.success).toBe(false);
  });

  it('rejects missing keys', () => {
    const parsed = PushSubscriptionRequestSchema.safeParse({ endpoint: validSub.endpoint });
    expect(parsed.success).toBe(false);
  });

  it('rejects empty p256dh / auth', () => {
    expect(
      PushSubscriptionRequestSchema.safeParse({
        endpoint: validSub.endpoint,
        keys: { p256dh: '', auth: 'x' },
      }).success,
    ).toBe(false);
    expect(
      PushSubscriptionRequestSchema.safeParse({
        endpoint: validSub.endpoint,
        keys: { p256dh: 'x', auth: '' },
      }).success,
    ).toBe(false);
  });

  // S86 리뷰 fix-forward (security MAJOR = SSRF): endpoint 호스트 allowlist.
  it('accepts known push-service hosts (https only)', () => {
    for (const endpoint of [
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://updates.push.services.mozilla.com/wpush/v2/xyz',
      'https://db5p.notify.windows.com/w/?token=abc',
      'https://web.push.apple.com/q/def',
    ]) {
      expect(PushSubscriptionRequestSchema.safeParse({ ...validSub, endpoint }).success).toBe(true);
    }
  });

  it('rejects SSRF / arbitrary / internal / non-https endpoints', () => {
    for (const endpoint of [
      'http://fcm.googleapis.com/fcm/send/abc', // non-https
      'https://169.254.169.254/latest/meta-data', // link-local
      'https://localhost:5432/', // internal
      'https://qufox-redis-prod:6379/', // internal NAS host
      'https://evil.com/fcm/send/abc', // arbitrary host
      'https://evil-fcm.googleapis.com.attacker.com/x', // label-boundary spoof
      'https://notify.windows.com.attacker.com/x', // suffix spoof
    ]) {
      expect(PushSubscriptionRequestSchema.safeParse({ ...validSub, endpoint }).success).toBe(
        false,
      );
    }
  });
});

describe('PushUnsubscribeRequestSchema', () => {
  it('accepts an endpoint URL', () => {
    expect(PushUnsubscribeRequestSchema.safeParse({ endpoint: validSub.endpoint }).success).toBe(
      true,
    );
  });
  it('rejects a non-URL endpoint', () => {
    expect(PushUnsubscribeRequestSchema.safeParse({ endpoint: 'nope' }).success).toBe(false);
  });
});

describe('VapidPublicKeyResponseSchema', () => {
  it('accepts a publicKey string (including empty = key unset)', () => {
    expect(VapidPublicKeyResponseSchema.safeParse({ publicKey: 'BKey...' }).success).toBe(true);
    expect(VapidPublicKeyResponseSchema.safeParse({ publicKey: '' }).success).toBe(true);
  });
  it('rejects a missing publicKey', () => {
    expect(VapidPublicKeyResponseSchema.safeParse({}).success).toBe(false);
  });
});

describe('ErrorCode enum', () => {
  it('accepts the new S86 push code', () => {
    expect(() => ErrorCodeSchema.parse('PUSH_SUBSCRIPTION_INVALID')).not.toThrow();
  });
});
