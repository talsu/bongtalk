import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UsersService } from '../../users/users.service';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';
import type { CurrentUserPayload } from '../decorators/current-user.decorator';

type JwtPayload = { sub: string; type?: string };

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly users: UsersService) {
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
    const user = await this.users.findById(payload.sub);
    if (!user) {
      throw new DomainError(ErrorCode.AUTH_INVALID_TOKEN, 'user no longer exists');
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
