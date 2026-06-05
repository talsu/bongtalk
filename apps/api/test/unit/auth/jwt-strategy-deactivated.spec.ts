import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { JwtStrategy } from '../../../src/auth/strategies/jwt.strategy';
import { UsersService } from '../../../src/users/users.service';
import { DomainError } from '../../../src/common/errors/domain-error';
import { ErrorCode } from '../../../src/common/errors/error-code.enum';

/**
 * S77c (D14 / FR-PS-16): JWT isDeactivated 이중검사 단위 검증.
 *   ① Redis `deactivated:{userId}` 블랙리스트 → 즉시 차단(DB 조회 전).
 *   ② DB isDeactivated=true → 차단(블랙리스트 TTL 만료 후 영속 출처).
 *   활성 계정은 통과(emailVerified 동봉).
 * 외부 모킹 라이브러리 금지 — vi.fn() 으로만 흉내낸다.
 */
beforeEach(() => {
  vi.setSystemTime('2025-01-01T00:00:00Z');
});

const ACTIVE_USER = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  email: 'a@qufox.dev',
  username: 'alice',
  emailVerified: true,
  isDeactivated: false,
};

function makeStrategy(opts: {
  blacklisted: boolean;
  user: (typeof ACTIVE_USER & { isDeactivated: boolean }) | null;
}) {
  const get = vi.fn().mockResolvedValue(opts.blacklisted ? '1' : null);
  const findById = vi.fn().mockResolvedValue(opts.user);
  const users = { findById } as unknown as UsersService;
  const redis = { get } as unknown as Redis;
  return { strategy: new JwtStrategy(users, redis), get, findById };
}

describe('JwtStrategy.validate — isDeactivated 이중검사', () => {
  const payload = { sub: ACTIVE_USER.id, type: 'access' as const };

  it('Redis 블랙리스트 적중 → ACCOUNT_DEACTIVATED(DB 조회 전 차단)', async () => {
    const { strategy, findById } = makeStrategy({ blacklisted: true, user: ACTIVE_USER });
    await expect(strategy.validate(payload)).rejects.toMatchObject({
      code: ErrorCode.ACCOUNT_DEACTIVATED,
    });
    // 블랙리스트 적중 시 DB 조회를 생략한다(즉시 차단).
    expect(findById).not.toHaveBeenCalled();
  });

  it('DB isDeactivated=true → ACCOUNT_DEACTIVATED(블랙리스트 미적중이어도 차단)', async () => {
    const { strategy } = makeStrategy({
      blacklisted: false,
      user: { ...ACTIVE_USER, isDeactivated: true },
    });
    await expect(strategy.validate(payload)).rejects.toBeInstanceOf(DomainError);
    await expect(strategy.validate(payload)).rejects.toMatchObject({
      code: ErrorCode.ACCOUNT_DEACTIVATED,
    });
  });

  it('활성 계정 → CurrentUserPayload 통과(emailVerified 동봉)', async () => {
    const { strategy } = makeStrategy({ blacklisted: false, user: ACTIVE_USER });
    const res = await strategy.validate(payload);
    expect(res).toEqual({
      id: ACTIVE_USER.id,
      email: ACTIVE_USER.email,
      username: ACTIVE_USER.username,
      emailVerified: true,
    });
  });

  it('access 가 아닌 토큰 → AUTH_INVALID_TOKEN', async () => {
    const { strategy } = makeStrategy({ blacklisted: false, user: ACTIVE_USER });
    await expect(strategy.validate({ sub: ACTIVE_USER.id, type: 'refresh' })).rejects.toMatchObject(
      { code: ErrorCode.AUTH_INVALID_TOKEN },
    );
  });

  it('사용자 미존재 → AUTH_INVALID_TOKEN', async () => {
    const { strategy } = makeStrategy({ blacklisted: false, user: null });
    await expect(strategy.validate(payload)).rejects.toMatchObject({
      code: ErrorCode.AUTH_INVALID_TOKEN,
    });
  });
});
