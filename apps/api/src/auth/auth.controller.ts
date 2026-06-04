import { Body, Controller, Get, HttpCode, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { VerificationResendResponse, VerifyEmailResponse } from '@qufox/shared-types';
import { AuthService } from './auth.service';
import { SignupDto } from './dto/signup.dto';
import { LoginDto } from './dto/login.dto';
import { Public } from './decorators/public.decorator';
import { CurrentUser, CurrentUserPayload } from './decorators/current-user.decorator';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { BetaInviteRequiredGuard } from './guards/beta-invite-required.guard';
// S66 (D13 / FR-W05b): 이메일 인증 토큰 검증/재발송.
import { EmailVerificationService } from './services/email-verification.service';
// S66 fix-forward (review HIGH-2): @Public GET /auth/verify-email 에 IP rate-limit 적용.
import { RateLimitService } from './services/rate-limit.service';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';

const REFRESH_COOKIE = 'refresh_token';
// Cookie Path is `/` because in production the frontend calls through an
// nginx proxy whose URL prefix (`/api/`) differs from what the API sees
// internally (`/auth/...`). Browser cookie-matching compares the request
// URL path to the stored Path, so `Path=/auth` made the browser omit the
// cookie on `/api/auth/refresh` calls — refresh + logout both 401'd in
// prod with "refresh cookie missing". HttpOnly + Secure + SameSite=strict
// remain on, so narrowing the Path added no real security margin.
const COOKIE_PATH = '/';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    // S66 (D13 / FR-W05b): verify-email / resend-verification 처리.
    private readonly emailVerification: EmailVerificationService,
    // S66 fix-forward (review HIGH-2): verify-email IP rate-limit.
    private readonly rateLimit: RateLimitService,
  ) {}

  private allowedOrigins(): string[] {
    const raw = process.env.CORS_ORIGINS ?? '';
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  private ensureAllowedOrigin(req: Request): void {
    const origin = req.headers.origin;
    // Absence of Origin happens for server-to-server requests; still treat
    // strictly: refresh/logout require a browser origin.
    if (typeof origin !== 'string' || !this.allowedOrigins().includes(origin)) {
      throw new DomainError(ErrorCode.AUTH_INVALID_TOKEN, 'origin not allowed');
    }
  }

  private setRefreshCookie(res: Response, raw: string, maxAgeMs: number): void {
    res.cookie(REFRESH_COOKIE, raw, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: COOKIE_PATH,
      maxAge: maxAgeMs,
    });
  }

  private clearRefreshCookie(res: Response): void {
    res.cookie(REFRESH_COOKIE, '', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: COOKIE_PATH,
      maxAge: 0,
    });
  }

  private readMeta(req: Request): { userAgent?: string; ip?: string } {
    return {
      userAgent:
        typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
      ip: req.ip,
    };
  }

  // S66 fix-forward (review HIGH-2): rate-limit 키에 쓸 클라이언트 IP. nginx 프록시 뒤라
  // X-Forwarded-For 의 첫 홉(원 클라이언트)을 우선하고, 없으면 Express req.ip(login/signup
  // 의 readMeta 와 동일 소스)로 폴백한다. 미상이면 'unknown' 단일 버킷으로 묶는다.
  private clientIp(req: Request): string {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length > 0) {
      const first = fwd.split(',')[0]?.trim();
      if (first) return first;
    }
    if (Array.isArray(fwd) && fwd.length > 0) {
      const first = fwd[0]?.split(',')[0]?.trim();
      if (first) return first;
    }
    return req.ip ?? 'unknown';
  }

  @Public()
  @UseGuards(BetaInviteRequiredGuard)
  @Post('signup')
  async signup(
    @Body() dto: SignupDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.signup(dto, this.readMeta(req));
    this.setRefreshCookie(res, result.refreshRaw, this.refreshTtlMs());
    return {
      accessToken: result.accessToken,
      user: {
        id: result.user.id,
        email: result.user.email,
        username: result.user.username,
        createdAt: result.user.createdAt.toISOString(),
        // S66 (D13 / FR-W05b): 가입 직후 emailVerified=false — 클라이언트가 인증 대기
        // 화면으로 분기한다.
        emailVerified: result.user.emailVerified,
      },
    };
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.login(dto, this.readMeta(req));
    this.setRefreshCookie(res, result.refreshRaw, this.refreshTtlMs());
    return {
      accessToken: result.accessToken,
      user: {
        id: result.user.id,
        email: result.user.email,
        username: result.user.username,
        createdAt: result.user.createdAt.toISOString(),
        // S66 (D13 / FR-W05b): emailVerified=false 면 클라이언트가 인증 대기 화면 렌더.
        emailVerified: result.user.emailVerified,
      },
    };
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.ensureAllowedOrigin(req);
    const raw = (req.cookies ?? {})[REFRESH_COOKIE];
    if (typeof raw !== 'string' || raw.length === 0) {
      throw new DomainError(ErrorCode.AUTH_INVALID_TOKEN, 'refresh cookie missing');
    }
    const result = await this.auth.refresh(raw, this.readMeta(req));
    this.setRefreshCookie(res, result.refreshRaw, this.refreshTtlMs());
    return { accessToken: result.accessToken };
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.ensureAllowedOrigin(req);
    const raw = (req.cookies ?? {})[REFRESH_COOKIE];
    await this.auth.logout(typeof raw === 'string' ? raw : undefined);
    this.clearRefreshCookie(res);
    return undefined;
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@CurrentUser() user: CurrentUserPayload) {
    // S66 (D13 / FR-W05b): emailVerified 를 포함해 반환한다(JwtStrategy 가 DB 에서 매
    // 요청 로드 — verify-email 직후 "이미 인증했어요" 재조회가 즉시 true 를 본다).
    return {
      id: user.id,
      email: user.email,
      username: user.username,
      emailVerified: user.emailVerified,
    };
  }

  // S66 (D13 / FR-W05b): 이메일 인증. token 쿼리 검증 → usedAt 기록(재사용 차단) +
  // User.emailVerified=true. 만료 410 / 무효·재사용 400 은 도메인 에러가 필터에서 매핑.
  // GET 으로 두어 메일 클라이언트 링크 클릭(브라우저 GET)으로 바로 도달 가능하게 한다.
  @Public()
  @Get('verify-email')
  async verifyEmail(
    @Query('token') token: string | undefined,
    @Req() req: Request,
  ): Promise<VerifyEmailResponse> {
    // S66 fix-forward (review HIGH-2): @Public GET 라 인증 없이 토큰 추측 brute-force /
    // 토큰 enumeration 표면이다. IP 당 20회/60초로 제한해 무차별 시도를 막는다(login/
    // signup 의 IP 추출 관례를 따르는 clientIp 사용). 초과 시 429 RATE_LIMITED.
    await this.rateLimit.enforce([
      { key: `verify-email:ip:${this.clientIp(req)}`, windowSec: 60, max: 20 },
    ]);
    if (typeof token !== 'string' || token.length === 0) {
      throw new DomainError(
        ErrorCode.EMAIL_VERIFICATION_TOKEN_INVALID,
        'verification token is required',
      );
    }
    await this.emailVerification.verify(token);
    return { emailVerified: true };
  }

  // S66 (D13 / FR-W05b): 인증 메일 재발송. JWT 필요(본인 이메일로만 재발송). 60초 쿨다운
  // + 1일 5회 한도 초과 시 429 EMAIL_VERIFICATION_RATE_LIMITED. 응답에 쿨다운 초 + 그날
  // 남은 횟수를 실어 클라이언트가 카운트다운/소진 안내를 그린다.
  @UseGuards(JwtAuthGuard)
  @Post('resend-verification')
  @HttpCode(200)
  async resendVerification(
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<VerificationResendResponse> {
    return this.emailVerification.resend(user.id, user.email);
  }

  private refreshTtlMs(): number {
    return Number(process.env.REFRESH_TOKEN_TTL ?? 604800) * 1000;
  }
}
