import { Body, Controller, NotFoundException, Post } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';
import { Public } from './decorators/public.decorator';

/**
 * 071-M0 C12 — e2e 테스트 스택 전용 훅.
 *
 * S66 이메일 인증 게이트 이후 e2e 가 만든 계정(emailVerified=false)은 /w/* UI 게이트와
 * 메시지 전송 403 에 막혀 모바일 스위트 전체가 silent-red 였다. Console-stub 메일의
 * 인증 토큰은 테스트 러너(Playwright 컨테이너)가 읽을 수 없으므로, 테스트 스택에서만
 * 이메일 인증을 직접 완료시키는 훅을 둔다.
 *
 * 이중 가드:
 *  ① 모듈 등록 자체가 `E2E_TEST_HOOKS === '1'` 일 때만 된다(auth.module.ts) —
 *     prod compose 엔 이 env 가 없어 라우트가 아예 존재하지 않는다.
 *  ② 등록됐더라도 런타임에 한 번 더 검사해 flag 가 없으면 404 로 위장한다.
 * docker-compose.test.yml / docker-compose.e2e-audit.yml 의 test-api 만 flag 를 켠다.
 */
@Controller('auth/test-hooks')
export class E2eTestHooksController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Post('verify-email')
  async verifyEmail(@Body() body: { email?: string }): Promise<{ emailVerified: true }> {
    // 071-M0 리뷰 M3: flag 가드 2곳이 같은 env 를 읽어 실질 단일 스위치였다 —
    // NODE_ENV=production 이면 flag 와 무관하게 무조건 404(독립 2팩터).
    if (
      process.env.NODE_ENV === 'production' ||
      process.env.E2E_TEST_HOOKS !== '1' ||
      !body?.email
    ) {
      throw new NotFoundException();
    }
    try {
      await this.prisma.user.update({
        where: { email: body.email },
        data: { emailVerified: true },
      });
    } catch {
      // 071-M0 리뷰 L6: 미존재 이메일의 Prisma P2025 가 500 으로 새지 않게 404 로 위장.
      throw new NotFoundException();
    }
    return { emailVerified: true };
  }
}
