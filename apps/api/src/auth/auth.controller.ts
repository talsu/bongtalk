import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { SignupDto } from './dto/signup.dto';
import { LoginDto } from './dto/login.dto';
import { Public } from './decorators/public.decorator';
import { CurrentUser, CurrentUserPayload } from './decorators/current-user.decorator';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
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
  constructor(private readonly auth: AuthService) {}

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

  @Public()
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
    return user;
  }

  private refreshTtlMs(): number {
    return Number(process.env.REFRESH_TOKEN_TTL ?? 604800) * 1000;
  }
}
