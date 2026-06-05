import { Inject, Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type Redis from 'ioredis';
import { UsersService } from '../../users/users.service';
import { REDIS } from '../../redis/redis.module';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';
import type { CurrentUserPayload } from '../decorators/current-user.decorator';

type JwtPayload = { sub: string; type?: string };

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly users: UsersService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey:
        process.env.JWT_ACCESS_SECRET ?? 'change-me-access-secret-at-least-32-chars-long',
      issuer: process.env.JWT_ISSUER ?? 'qufox',
      audience: process.env.JWT_AUDIENCE ?? 'qufox-web',
    });
  }

  async validate(payload: JwtPayload): Promise<CurrentUserPayload> {
    if (payload.type !== 'access') {
      throw new DomainError(ErrorCode.AUTH_INVALID_TOKEN, 'not an access token');
    }
    // S77c (D14 / FR-PS-16): Redis 블랙리스트 이중검사 ① — `deactivated:{userId}` 가 존재하면(비활성화
    // 직후 15m 즉시 차단) DB 조회 전에 거부한다. 다기기 access token 이 살아 있어도 즉시 막힌다.
    const blacklisted = await this.redis.get(`deactivated:${payload.sub}`);
    if (blacklisted) {
      throw new DomainError(ErrorCode.ACCOUNT_DEACTIVATED, 'account is deactivated');
    }
    const user = await this.users.findById(payload.sub);
    if (!user) {
      throw new DomainError(ErrorCode.AUTH_INVALID_TOKEN, 'user no longer exists');
    }
    // S77c (D14 / FR-PS-16): DB isDeactivated 이중검사 ② — Redis TTL(15m) 만료 후에도 DB 컬럼이
    // 단일 출처로 계속 비활성 계정을 차단한다(블랙리스트는 즉시성, DB 는 영속성).
    if (user.isDeactivated) {
      throw new DomainError(ErrorCode.ACCOUNT_DEACTIVATED, 'account is deactivated');
    }
    // S66 (D13 / FR-W05a): emailVerified 를 토큰 검증 시 함께 싣는다(진입/전송 게이트가
    // 재확인 — "채널 진입 시점에 emailVerified 재확인"). 매 요청 DB 조회이므로 verify-email
    // 직후 다음 요청부터 즉시 반영된다(JWT payload 가 아닌 DB 가 단일 출처).
    return {
      id: user.id,
      email: user.email,
      username: user.username,
      emailVerified: user.emailVerified,
    };
  }
}
