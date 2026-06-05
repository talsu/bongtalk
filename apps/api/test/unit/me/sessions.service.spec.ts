import { describe, expect, it, vi } from 'vitest';
import { SessionsService, deviceNameFromUserAgent } from '../../../src/me/sessions.service';

describe('S77b deviceNameFromUserAgent (FR-PS-15)', () => {
  it('Chrome on Windows 를 요약한다', () => {
    expect(
      deviceNameFromUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      ),
    ).toBe('Chrome · Windows');
  });

  it('Safari on macOS 를 요약한다', () => {
    expect(
      deviceNameFromUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      ),
    ).toBe('Safari · macOS');
  });

  it('Firefox 단독(미상 OS)도 브라우저명만 반환', () => {
    expect(deviceNameFromUserAgent('Firefox/121.0')).toBe('Firefox');
  });

  it('null/빈 문자열은 null', () => {
    expect(deviceNameFromUserAgent(null)).toBeNull();
    expect(deviceNameFromUserAgent('   ')).toBeNull();
  });

  it('미상 UA 는 raw 를 (과하면 잘라서) 반환', () => {
    expect(deviceNameFromUserAgent('curl/8.0')).toBe('curl/8.0');
  });
});

describe('S77b SessionsService.listSessions (FR-PS-15)', () => {
  it('isCurrent 는 현재 familyId 와 일치하는 세션만 true', async () => {
    const tokens = {
      listSessions: vi.fn(async () => [
        {
          id: 's1',
          familyId: 'fam-current',
          userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36',
          ip: '1.2.3.4',
          createdAt: new Date('2025-01-01T00:00:00Z'),
          lastSeenAt: new Date('2025-01-02T00:00:00Z'),
        },
        {
          id: 's2',
          familyId: 'fam-other',
          userAgent: null,
          ip: null,
          createdAt: new Date('2024-12-30T00:00:00Z'),
          lastSeenAt: null,
        },
      ]),
    };
    const svc = new SessionsService(tokens as never);
    const out = await svc.listSessions('u1', 'fam-current');
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      id: 's1',
      isCurrent: true,
      deviceName: 'Chrome · Windows',
      lastSeenAt: '2025-01-02T00:00:00.000Z',
    });
    expect(out[1]).toMatchObject({
      id: 's2',
      isCurrent: false,
      deviceName: null,
      lastSeenAt: null,
    });
  });

  it('currentFamilyId 가 null 이면 어떤 세션도 isCurrent 아님', async () => {
    const tokens = {
      listSessions: vi.fn(async () => [
        {
          id: 's1',
          familyId: 'fam-1',
          userAgent: null,
          ip: null,
          createdAt: new Date('2025-01-01T00:00:00Z'),
          lastSeenAt: null,
        },
      ]),
    };
    const svc = new SessionsService(tokens as never);
    const out = await svc.listSessions('u1', null);
    expect(out[0].isCurrent).toBe(false);
  });
});
