import { Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { UsersService } from '../users/users.service';
import { PasswordService } from './services/password.service';
import { TokenService } from './services/token.service';
import { RateLimitService } from './services/rate-limit.service';
// S66 (D13 / FR-W05b): signup 시 이메일 인증 토큰 발급 + Console stub 발송.
import { EmailVerificationService } from './services/email-verification.service';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { MetricsService } from '../observability/metrics/metrics.service';

export type SignupInput = { email: string; username: string; password: string };
export type LoginInput = { email: string; password: string };
export type RequestMeta = { userAgent?: string; ip?: string };

export type AuthSuccess = {
  accessToken: string;
  refreshRaw: string;
  // S66 (D13 / FR-W05a/W05b): 컨트롤러가 응답·세션에 실어 클라이언트가 인증 게이트로
  // 분기하도록 emailVerified 를 함께 돌려준다(signup 직후는 항상 false).
  user: { id: string; email: string; username: string; createdAt: Date; emailVerified: boolean };
};

// task-078: verifyCredentials() 가 돌려주는 *좁힌* 인증 사용자 — passwordHash/lockedUntil
// 같은 민감 필드를 노출하지 않는다(public 메서드라 다음 호출자 footgun 방지; reviewer M2).
export type VerifiedUser = {
  id: string;
  email: string;
  username: string;
  createdAt: Date;
  emailVerified: boolean;
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
    // S66 (D13 / FR-W05b): signup 시 인증 토큰 발급 + Console stub 발송.
    private readonly emailVerification: EmailVerificationService,
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

    // S66 (D13 / FR-W05b): 가입 직후 이메일 인증 토큰 발급 + Console stub 으로 verifyUrl
    // 발송. JWT 발급은 유지(emailVerified=false 상태로 로그인은 되지만 워크스페이스 진입·
    // 메시지 전송 게이트에서 차단됨). 메일 발송 실패가 가입 자체를 막지 않도록, 토큰 발급은
    // 베스트-에포트가 아닌 필수(트랜잭션 밖)지만 throw 시 가입 전체가 500 으로 실패한다 —
    // Console stub 은 실패하지 않으므로 MVP 에서 안전하다(SMTP 어댑터 교체 시 재검토).
    await this.emailVerification.issueAndSend(user.id, user.email);

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
        emailVerified: user.emailVerified,
      },
    };
  }

  async login(input: LoginInput, meta: RequestMeta): Promise<AuthSuccess> {
    const user = await this.verifyCredentials(input, meta);
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
        emailVerified: user.emailVerified,
      },
    };
  }

  // task-078 (Family SSO): 자격검증 코어 — rate-limit(IP/email)·계정 잠금·argon2 검증·
  // deactivation 차단·성공 시 updateLoginSuccess 까지 수행하되 *토큰을 발급하지 않는다*.
  // login() 과 OIDC IdP interaction 이 공유한다. IdP 로그인은 qufox refresh 세션을 만들
  // 필요가 없으므로(RP 가 자체 세션을 가짐) 이 메서드로 검증만 하고 user.id 를 sub 로 쓴다
  // — phantom refresh 세션이 사용자의 활성 세션 목록을 오염시키지 않게 한다.
  async verifyCredentials(input: LoginInput, meta: RequestMeta): Promise<VerifiedUser> {
    // IP-scoped rate limit runs first — protects against enumeration regardless
    // of whether the email exists.
    await this.rateLimit.enforce([
      // 071-M0 C12: e2e 스택(단일 IP에서 스펙당 1로그인 병렬)이 고정 10/분에 걸려
      // 스위트가 비결정적으로 깨졌다 — MESSAGE_RATE_* 패턴대로 env 상향만 허용
      // (기본값 10 유지, prod 미설정).
      {
        key: `login:ip:${meta.ip ?? 'unknown'}`,
        windowSec: 60,
        // 리뷰 L2: env 오타가 NaN 이 되면 enforce 의 `count > max` 가 항상 false 로
        // 떨어져 로그인 IP 리밋이 조용히 전면 해제된다(빈 문자열은 0 → 전면 차단).
        // 양의 유한수가 아니면 기본 10 으로 강제한다.
        max:
          Number.isFinite(Number(process.env.LOGIN_RATE_IP_MAX)) &&
          Number(process.env.LOGIN_RATE_IP_MAX) > 0
            ? Number(process.env.LOGIN_RATE_IP_MAX)
            : 10,
      },
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

    // S77c (D14 / FR-PS-16): 비활성 계정은 자격증명이 맞아도 로그인을 차단하고 ACCOUNT_DEACTIVATED 로
    // 응답한다(403). FE 는 이 코드를 받아 "계정 복구" CTA(POST /users/me/reactivate)로 분기한다.
    // 자격증명 검증을 먼저 통과시킨 뒤 분기하므로(존재/비번 확인 완료) 복구 CTA 노출이 안전하다.
    if (user.isDeactivated) {
      this.metrics?.authLoginsTotal.labels('deactivated').inc();
      throw new DomainError(ErrorCode.ACCOUNT_DEACTIVATED, 'account is deactivated');
    }

    await this.users.updateLoginSuccess(user.id);
    // task-078: 이 카운터는 이제 web 로그인 + OIDC IdP 로그인(둘 다 verifyCredentials 경유)을
    // 함께 집계한다(성공/실패 라벨 동일). SSO 라이브 후 surface 분리가 필요하면 라벨 추가.
    this.metrics?.authLoginsTotal.labels('success').inc();
    return {
      id: user.id,
      email: user.email,
      username: user.username,
      createdAt: user.createdAt,
      emailVerified: user.emailVerified,
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
