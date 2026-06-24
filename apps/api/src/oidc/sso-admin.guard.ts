// task-078 P2-acl: SSO 관리 API 가드. 전역 JwtAuthGuard(APP_GUARD) 다음에 돌아 req.user 가
// 채워진 상태에서, 그 이메일이 SSO_ADMIN_EMAILS 에 있는지 확인한다(관리자만 RP 승인 관리).
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { isSsoAdminEmail } from './oidc-config';

@Injectable()
export class SsoAdminGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const email: string | undefined = req.user?.email;
    if (!isSsoAdminEmail(email)) {
      throw new ForbiddenException('SSO admin only');
    }
    return true;
  }
}
