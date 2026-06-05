import { ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector?.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(context);
  }

  handleRequest<TUser>(err: unknown, user: TUser): TUser {
    // S77c (D14 / FR-PS-16): JwtStrategy.validate 가 던진 DomainError(예: ACCOUNT_DEACTIVATED 403)는
    // 그대로 전파한다 — passport 가 strategy 예외를 err 로 넘기므로, 여기서 일괄 AUTH_INVALID_TOKEN
    // (401)으로 덮으면 비활성 계정 차단의 정확한 코드/상태가 사라진다. DomainError 가 아닌 일반 인증
    // 실패(토큰 누락/만료/형식 오류)만 AUTH_INVALID_TOKEN 으로 매핑한다.
    if (err instanceof DomainError) {
      throw err;
    }
    if (err || !user) {
      throw new DomainError(ErrorCode.AUTH_INVALID_TOKEN, 'access token required');
    }
    return user;
  }
}
