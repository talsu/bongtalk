import { describe, expect, it } from 'vitest';
import { classifyPushDevice } from './push-device';
import {
  ChannelNotificationPreferenceSchema,
  PutChannelNotificationPreferenceRequestSchema,
} from './notifications';

/**
 * S87 (FR-MN-18): push 구독 device 분류 + 채널 알림 prefs push 토글 스키마.
 */
describe('classifyPushDevice — 대표 모바일 UA', () => {
  const MOBILE_UAS: ReadonlyArray<[string, string]> = [
    [
      'Android Chrome',
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
    ],
    [
      'iPhone Safari',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    ],
    [
      'iPad Safari',
      'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    ],
    [
      'iPod',
      'Mozilla/5.0 (iPod touch; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
    ],
    [
      'Windows Phone',
      'Mozilla/5.0 (Windows Phone 10.0; Android 6.0.1; Microsoft; Lumia 950) AppleWebKit/537.36 IEMobile/11.0',
    ],
    ['Android Firefox', 'Mozilla/5.0 (Android 13; Mobile; rv:120.0) Gecko/120.0 Firefox/120.0'],
    [
      'Samsung Internet',
      'Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/19.0 Chrome/102.0 Mobile Safari/537.36',
    ],
  ];

  it.each(MOBILE_UAS)('%s → mobile', (_label, ua) => {
    expect(classifyPushDevice(ua)).toBe('mobile');
  });
});

describe('classifyPushDevice — 대표 데스크톱 UA', () => {
  const DESKTOP_UAS: ReadonlyArray<[string, string]> = [
    [
      'Windows Chrome',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    ],
    [
      'macOS Safari',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    ],
    [
      'Linux Firefox',
      'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0',
    ],
    [
      'Windows Edge',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Edg/120.0',
    ],
  ];

  it.each(DESKTOP_UAS)('%s → desktop', (_label, ua) => {
    expect(classifyPushDevice(ua)).toBe('desktop');
  });
});

describe('classifyPushDevice — 빈값/미상은 보수적으로 desktop', () => {
  it('null → desktop', () => {
    expect(classifyPushDevice(null)).toBe('desktop');
  });
  it('undefined → desktop', () => {
    expect(classifyPushDevice(undefined)).toBe('desktop');
  });
  it('빈 문자열 → desktop', () => {
    expect(classifyPushDevice('')).toBe('desktop');
  });
  it('알 수 없는 UA → desktop', () => {
    expect(classifyPushDevice('curl/8.0')).toBe('desktop');
  });
  it('macOS(Mac OS X)는 mobile 토큰이 아니므로 desktop (Mobile 부분일치 회피)', () => {
    // "Mac OS X" 에 'Mobile' 단어 경계가 없어 데스크톱 분류가 유지되는지(과분류 회피).
    expect(classifyPushDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('desktop');
  });
});

describe('ChannelNotificationPreferenceSchema — push 토글 필드(S87)', () => {
  it('pushDesktop/pushMobile 가 boolean|null 을 허용한다', () => {
    const ok = ChannelNotificationPreferenceSchema.safeParse({
      level: null,
      isMuted: false,
      muteUntil: null,
      pushDesktop: false,
      pushMobile: null,
    });
    expect(ok.success).toBe(true);
  });

  it('push 필드 누락은 거부(응답 스키마는 항상 노출)', () => {
    const bad = ChannelNotificationPreferenceSchema.safeParse({
      level: null,
      isMuted: false,
      muteUntil: null,
    });
    expect(bad.success).toBe(false);
  });
});

describe('PutChannelNotificationPreferenceRequestSchema — push 토글 부분 갱신(S87)', () => {
  it('pushDesktop=false 단독 갱신을 허용한다', () => {
    const r = PutChannelNotificationPreferenceRequestSchema.safeParse({ pushDesktop: false });
    expect(r.success).toBe(true);
  });

  it('pushMobile=null(명시 상속) 을 허용한다', () => {
    const r = PutChannelNotificationPreferenceRequestSchema.safeParse({ pushMobile: null });
    expect(r.success).toBe(true);
  });

  it('push 필드 생략(미변경)도 유효하다', () => {
    const r = PutChannelNotificationPreferenceRequestSchema.safeParse({ level: 'ALL' });
    expect(r.success).toBe(true);
  });

  it('push 필드에 숫자는 거부', () => {
    const r = PutChannelNotificationPreferenceRequestSchema.safeParse({ pushDesktop: 1 });
    expect(r.success).toBe(false);
  });
});
