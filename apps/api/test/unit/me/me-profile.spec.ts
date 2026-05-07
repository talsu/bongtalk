import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MeProfileController } from '../../../src/me/me-profile.controller';
import type { PrismaService } from '../../../src/prisma/prisma.module';
import type { RateLimitService } from '../../../src/auth/services/rate-limit.service';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

const ME = '11111111-1111-4111-8111-111111111111';

function makeCtrl({
  findUnique,
  update,
}: { findUnique?: ReturnType<typeof vi.fn>; update?: ReturnType<typeof vi.fn> } = {}) {
  // task-047 iter3 (M2): default mock 가 controller 의 select 결과 shape
  // ({ bio, links }) 를 반환하도록 보강. 개별 spec 은 mock override.
  const prisma = {
    user: {
      findUnique: findUnique ?? vi.fn(),
      update: update ?? vi.fn().mockResolvedValue({ bio: null, links: null }),
    },
  } as unknown as PrismaService;
  const rate = { enforce: vi.fn().mockResolvedValue(undefined) } as unknown as RateLimitService;
  return { ctrl: new MeProfileController(prisma, rate), prisma, rate };
}

describe('MeProfileController.get (task-046 M1)', () => {
  it('User row 반환 + bio 포함', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: ME,
      username: 'me',
      email: 'me@e.com',
      customStatus: null,
      bio: 'hello world',
    });
    const { ctrl } = makeCtrl({ findUnique });
    const res = await ctrl.get({ id: ME, email: 'me@e.com', username: 'me' });
    expect(res.bio).toBe('hello world');
  });

  it('user 없으면 profile not found', async () => {
    const { ctrl } = makeCtrl({ findUnique: vi.fn().mockResolvedValue(null) });
    await expect(ctrl.get({ id: ME, email: 'me@e.com', username: 'me' })).rejects.toThrow(
      /profile not found/,
    );
  });
});

describe('MeProfileController.patch (task-046 M1)', () => {
  it('bio null → 저장도 null', async () => {
    const update = vi.fn().mockResolvedValue({});
    const { ctrl } = makeCtrl({ update });
    const res = await ctrl.patch({ id: ME, email: 'me@e.com', username: 'me' }, { bio: null });
    expect(res.bio).toBeNull();
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ME },
        data: { bio: null },
      }),
    );
  });

  it('bio 빈 trim 결과 → null', async () => {
    const update = vi.fn().mockResolvedValue({});
    const { ctrl } = makeCtrl({ update });
    const res = await ctrl.patch({ id: ME, email: 'me@e.com', username: 'me' }, { bio: '   ' });
    expect(res.bio).toBeNull();
  });

  it('bio 정상 string → trim 저장', async () => {
    const update = vi.fn().mockResolvedValue({});
    const { ctrl } = makeCtrl({ update });
    const res = await ctrl.patch(
      { id: ME, email: 'me@e.com', username: 'me' },
      { bio: '  안녕  ' },
    );
    expect(res.bio).toBe('안녕');
  });

  it('bio 가 string 이 아니면 VALIDATION_FAILED', async () => {
    const { ctrl } = makeCtrl();
    await expect(
      ctrl.patch(
        { id: ME, email: 'me@e.com', username: 'me' },
        {
          bio: 42 as unknown as string,
        },
      ),
    ).rejects.toThrow(/string or null/);
  });

  it('bio 길이 > 500 → VALIDATION_FAILED', async () => {
    const { ctrl } = makeCtrl();
    await expect(
      ctrl.patch({ id: ME, email: 'me@e.com', username: 'me' }, { bio: 'x'.repeat(501) }),
    ).rejects.toThrow(/too long/);
  });

  it('bio 500 chars exactly → 정상', async () => {
    const update = vi.fn().mockResolvedValue({});
    const { ctrl } = makeCtrl({ update });
    const res = await ctrl.patch(
      { id: ME, email: 'me@e.com', username: 'me' },
      {
        bio: 'x'.repeat(500),
      },
    );
    expect(res.bio).toBe('x'.repeat(500));
  });

  it('rate limit 호출 (10/min/user)', async () => {
    const { ctrl, rate } = makeCtrl();
    await ctrl.patch({ id: ME, email: 'me@e.com', username: 'me' }, { bio: 'hi' });
    expect(rate.enforce).toHaveBeenCalledWith([
      { key: `me-profile:u:${ME}`, windowSec: 60, max: 10 },
    ]);
  });

  /**
   * task-047 iter3 (M2): links 검증.
   */
  it('links null → 저장 시 Prisma.JsonNull (links: null 반환)', async () => {
    const update = vi.fn().mockResolvedValue({ bio: null, links: null });
    const { ctrl } = makeCtrl({ update });
    const res = await ctrl.patch({ id: ME, email: 'me@e.com', username: 'me' }, { links: null });
    expect(res.links).toBeNull();
  });

  it('links 빈 배열 → null', async () => {
    const update = vi.fn().mockResolvedValue({ bio: null, links: null });
    const { ctrl } = makeCtrl({ update });
    const res = await ctrl.patch({ id: ME, email: 'me@e.com', username: 'me' }, { links: [] });
    expect(res.links).toBeNull();
  });

  it('links 정상 1개 (url + label)', async () => {
    const expected = [{ url: 'https://example.com', label: 'home' }];
    const update = vi.fn().mockResolvedValue({ bio: null, links: expected });
    const { ctrl } = makeCtrl({ update });
    const res = await ctrl.patch(
      { id: ME, email: 'me@e.com', username: 'me' },
      { links: expected },
    );
    expect(res.links).toEqual(expected);
  });

  it('links url 이 https?:// 시작 안 하면 VALIDATION_FAILED', async () => {
    const { ctrl } = makeCtrl();
    await expect(
      ctrl.patch(
        { id: ME, email: 'me@e.com', username: 'me' },
        { links: [{ url: 'javascript:alert(1)' }] },
      ),
    ).rejects.toThrow(/http:\/\/ or https:\/\//);
  });

  it('links 4개 → too many links', async () => {
    const links = Array.from({ length: 4 }, (_, i) => ({ url: `https://e${i}.com` }));
    const { ctrl } = makeCtrl();
    await expect(
      ctrl.patch({ id: ME, email: 'me@e.com', username: 'me' }, { links }),
    ).rejects.toThrow(/too many links/);
  });

  it('links url 누락 → VALIDATION_FAILED', async () => {
    const { ctrl } = makeCtrl();
    await expect(
      ctrl.patch(
        { id: ME, email: 'me@e.com', username: 'me' },
        { links: [{ label: 'no url' } as { url?: string; label?: string }] },
      ),
    ).rejects.toThrow(/non-empty string/);
  });

  it('links label 33 chars → too long', async () => {
    const { ctrl } = makeCtrl();
    await expect(
      ctrl.patch(
        { id: ME, email: 'me@e.com', username: 'me' },
        { links: [{ url: 'https://example.com', label: 'x'.repeat(33) }] },
      ),
    ).rejects.toThrow(/label too long/);
  });

  it('bio + links 동시 update', async () => {
    const update = vi
      .fn()
      .mockResolvedValue({ bio: 'hi', links: [{ url: 'https://example.com' }] });
    const { ctrl } = makeCtrl({ update });
    const res = await ctrl.patch(
      { id: ME, email: 'me@e.com', username: 'me' },
      { bio: 'hi', links: [{ url: 'https://example.com' }] },
    );
    expect(res.bio).toBe('hi');
    expect(res.links).toEqual([{ url: 'https://example.com' }]);
  });
});
