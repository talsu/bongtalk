import { describe, expect, it } from 'vitest';
import { resolvePushPermission, toSubscriptionRequest, urlBase64ToUint8Array } from './webPush';

/**
 * S86 (FR-MN-15): webPush 순수 로직 단위 — 권한 상태 판정, base64url 변환, 구독 요청 변환.
 * 부수효과(register/subscribe/fetch)는 e2e/수동 + 컴포넌트 테스트(enablePush mock)에서 커버.
 */

function win(over: {
  permission?: NotificationPermission;
  sw?: boolean;
  push?: boolean;
  noNotification?: boolean;
}) {
  return {
    Notification: over.noNotification ? undefined : { permission: over.permission ?? 'default' },
    navigator: over.sw === false ? {} : { serviceWorker: {} },
    PushManager: over.push === false ? undefined : function PushManager() {},
  } as never;
}

describe('resolvePushPermission', () => {
  it('Notification API 부재 → unsupported', () => {
    expect(resolvePushPermission(win({ noNotification: true }))).toBe('unsupported');
  });
  it('serviceWorker 부재 → unsupported', () => {
    expect(resolvePushPermission(win({ sw: false }))).toBe('unsupported');
  });
  it('PushManager 부재 → unsupported', () => {
    expect(resolvePushPermission(win({ push: false }))).toBe('unsupported');
  });
  it('permission=default → default', () => {
    expect(resolvePushPermission(win({ permission: 'default' }))).toBe('default');
  });
  it('permission=granted → granted', () => {
    expect(resolvePushPermission(win({ permission: 'granted' }))).toBe('granted');
  });
  it('permission=denied → denied', () => {
    expect(resolvePushPermission(win({ permission: 'denied' }))).toBe('denied');
  });
});

describe('urlBase64ToUint8Array', () => {
  it('표준 base64url(padding 없음·URL-safe)을 바이트 배열로 변환한다', () => {
    // "hello" → base64 "aGVsbG8=" → base64url "aGVsbG8"(padding 제거)
    const bytes = urlBase64ToUint8Array('aGVsbG8');
    expect(Array.from(bytes)).toEqual([104, 101, 108, 108, 111]); // h e l l o
  });
  it('URL-safe 문자(-,_)를 표준 base64(+,/)로 치환한다', () => {
    // 0xFB 0xFF 0xBF → base64 "+/+/" → base64url "-_-_"
    const bytes = urlBase64ToUint8Array('-_-_');
    expect(Array.from(bytes)).toEqual([251, 255, 191]);
  });
});

describe('toSubscriptionRequest', () => {
  it('endpoint + keys 가 모두 있으면 요청 형태로 변환', () => {
    const req = toSubscriptionRequest({
      endpoint: 'https://push/e',
      keys: { p256dh: 'p', auth: 'a' },
    });
    expect(req).toEqual({ endpoint: 'https://push/e', keys: { p256dh: 'p', auth: 'a' } });
  });
  it('endpoint 누락 → null', () => {
    expect(toSubscriptionRequest({ keys: { p256dh: 'p', auth: 'a' } })).toBeNull();
  });
  it('키 누락 → null', () => {
    expect(toSubscriptionRequest({ endpoint: 'https://push/e', keys: { p256dh: 'p' } })).toBeNull();
  });
});
