import { Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { UsersService } from '../users/users.service';
import { PasswordService } from './services/password.service';
import { TokenService } from './services/token.service';
import { RateLimitService } from './services/rate-limit.service';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { MetricsService } from '../observability/metrics/metrics.service';

export type SignupInput = { email: string; username: string; password: string };
export type LoginInput = { email: string; password: string };
export type RequestMeta = { userAgent?: string; ip?: string };

export type AuthSuccess = {
  accessToken: string;
  refreshRaw: string;
  user: { id: string; email: string; username: string; createdAt: Date };
};

const LOCK_AFTER_FAILS = 5;
const LOCK_FOR_MS = 15 * 60 * 1000;

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly rateLimit: RateLimitService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  async signup(input: SignupInput, meta: RequestMeta): Promise<AuthSuccess> {
    this.passwords.validateStrength(input.password, input.email, input.username);

    if (await this.users.findByEmail(input.email)) {
      throw new DomainError(ErrorCode.AUTH_EMAIL_TAKEN, 'email already registered');
    }
    if (await this.users.findByUsername(input.username)) {
      throw new DomainError(ErrorCode.AUTH_USERNAME_TAKEN, 'username already taken');
    }

    const passwordHash = await this.passwords.hash(input.password);
    const user = await this.users.create({
      id: randomUUID(),
      email: input.email,
      username: input.username,
      passwordHash,
    });

    const accessToken = this.tokens.signAccess(user.id);
    const { raw: refreshRaw } = await this.tokens.issueRefreshForNewSession(user.id, meta);

    return {
      accessToken,
      refreshRaw,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        createdAt: user.createdAt,
      },
    };
  }

  async login(input: LoginInput, meta: RequestMeta): Promise<AuthSuccess> {
    // IP-scoped rate limit runs first — protects against enumeration regardless
    // of whether the email exists.
    await this.rateLimit.enforce([
      { key: `login:ip:${meta.ip ?? 'unknown'}`, windowSec: 60, max: 10 },
    ]);

    const user = await this.users.findByEmail(input.email);

    // If the account is already locked, surface that state explicitly — it
    // takes precedence over the per-email sliding window, which would
    // otherwise mask the lockout as a generic 429.
    if (user?.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      const retryAfterSec = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000);
      this.metrics?.authLoginsTotal.labels('locked').inc();
      throw new DomainError(
        ErrorCode.AUTH_ACCOUNT_LOCKED,
        'account temporarily locked due to repeated failed logins',
        { retryAfterSec },
      );
    }

    // Per-email sliding window kicks in once the account is confirmed unlocked.
    await this.rateLimit.enforce([{ key: `login:email:${input.email}`, windowSec: 900, max: 5 }]);

    // Always perform the argon2 verify step, even when user is missing, so the
    // success/failure/unknown timing profiles collapse.
    if (!user) {
      await this.passwords.dummyVerify(input.password);
      this.metrics?.authLoginsTotal.labels('invalid_credentials').inc();
      throw new DomainError(ErrorCode.AUTH_INVALID_CREDENTIALS, 'invalid credentials');
    }

    const ok = await this.passwords.verify(user.passwordHash, input.password);
    if (!ok) {
      await this.users.registerFailedLogin(user.id, LOCK_AFTER_FAILS, LOCK_FOR_MS);
      this.metrics?.authLoginsTotal.labels('invalid_credentials').inc();
      throw new DomainError(ErrorCode.AUTH_INVALID_CREDENTIALS, 'invalid credentials');
    }

    await this.users.updateLoginSuccess(user.id);
    this.metrics?.authLoginsTotal.labels('success').inc();
    const accessToken = this.tokens.signAccess(user.id);
    const { raw: refreshRaw } = await this.tokens.issueRefreshForNewSession(user.id, meta);

    return {
      accessToken,
      refreshRaw,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        createdAt: user.createdAt,
      },
    };
  }

  async refresh(
    refreshRaw: string,
    meta: RequestMeta,
  ): Promise<{ accessToken: string; refreshRaw: string }> {
    try {
      const rotated = await this.tokens.rotate(refreshRaw, meta);
      const accessToken = this.tokens.signAccess(rotated.userId);
      this.metrics?.authRefreshRotationsTotal.inc();
      return { accessToken, refreshRaw: rotated.raw };
    } catch (err) {
      if (err instanceof DomainError && err.code === ErrorCode.AUTH_SESSION_COMPROMISED) {
        this.metrics?.authSessionCompromisedTotal.inc();
      }
      throw err;
    }
  }

  async logout(refreshRaw: string | undefined): Promise<void> {
    if (!refreshRaw) return;
    await this.tokens.revokeRaw(refreshRaw);
  }
}
