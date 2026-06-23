// task-078 (Family SSO / OIDC IdP): oidc-provider 를 감싼 Nest 서비스.
//
// onModuleInit 에서 (SSO_ISSUER 가 있을 때만) ESM oidc-provider 를 동적 import 해 Provider 를
// 만든다. main.ts 가 sso.* host 요청을 이 서비스의 callback() 으로 라우팅한다. OIDC 가
// 깨지더라도 메인 API 부팅은 막지 않는다(다크 기능 — 격리; sso host 는 fall-through).
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from '../redis/redis.module';
import { PrismaService } from '../prisma/prisma.module';
import { CryptoService } from '../auth/services/crypto.service';
import { AuthService } from '../auth/auth.service';
import { logger } from '../common/logging/logger';
import { esmImport } from './esm';
import { buildConfiguration, getIssuer, isOidcEnabled } from './oidc-config';
import { buildSsoApp } from './oidc-interaction';

@Injectable()
export class OidcProviderService implements OnModuleInit {
  private provider: any = null;
  // interaction 라우트 + oidc-provider 콜백을 합친 sso.* host 전용 핸들러.
  private ssoHandler: ((req: any, res: any) => void) | null = null;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly authService: AuthService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!isOidcEnabled()) {
      logger.info('OIDC IdP disabled (SSO_ISSUER unset) — provider not initialized');
      return;
    }
    try {
      const issuer = getIssuer();
      const mod = await esmImport('oidc-provider');
      const Provider = mod.default ?? mod;
      const configuration = await buildConfiguration({
        redis: this.redis,
        loadClients: () => this.loadClients(),
        loadAccountClaims: (sub) => this.loadAccountClaims(sub),
      });
      const provider = new Provider(issuer, configuration);
      // nginx 단일 홉 뒤 — X-Forwarded-Proto/Host 를 신뢰해 https 발급자/리다이렉트를 맞춘다.
      provider.proxy = true;
      this.provider = provider;
      this.ssoHandler = buildSsoApp(provider, this.authService);
      logger.info(
        { issuer, clients: configuration.clients.length },
        'OIDC IdP initialized',
      );
    } catch (err) {
      logger.error({ err }, 'OIDC IdP failed to initialize — sso host will fall through');
      this.provider = null;
      this.ssoHandler = null;
    }
  }

  isEnabled(): boolean {
    return this.ssoHandler !== null;
  }

  /** sso.* host 요청을 처리하는 합성 핸들러(interaction + oidc-provider). 비활성 시 null. */
  getSsoHandler(): ((req: any, res: any) => void) | null {
    return this.ssoHandler;
  }

  getProvider(): any {
    return this.provider;
  }

  /** OAuthClient(enabled) 표를 oidc-provider client 메타 배열로 변환(부팅 1회). */
  private async loadClients(): Promise<any[]> {
    const rows = await this.prisma.oAuthClient.findMany({ where: { enabled: true } });
    return rows.map((row) => {
      const meta = ((row.metadata as Record<string, any> | null) ?? {}) as Record<string, any>;
      const secret = row.clientSecretEnc ? this.crypto.decrypt(row.clientSecretEnc) : undefined;
      const isPublic = !secret;
      const client: Record<string, any> = {
        client_id: row.clientId,
        redirect_uris: (row.redirectUris as string[] | null) ?? [],
        grant_types: meta.grantTypes ?? ['authorization_code', 'refresh_token'],
        response_types: meta.responseTypes ?? ['code'],
        post_logout_redirect_uris: meta.postLogoutRedirectUris ?? [],
        scope: (meta.scopes ?? ['openid', 'profile', 'email']).join(' '),
        token_endpoint_auth_method: isPublic
          ? 'none'
          : (meta.tokenAuthMethod ?? 'client_secret_basic'),
      };
      if (secret) {
        client.client_secret = secret;
      }
      if (meta.backchannelLogoutUri) {
        client.backchannel_logout_uri = meta.backchannelLogoutUri;
      }
      return client;
    });
  }

  /** sub(=qufox User.id) → OIDC 클레임. 비활성/미존재 계정은 null. */
  private async loadAccountClaims(sub: string): Promise<Record<string, any> | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: sub },
      select: {
        id: true,
        email: true,
        emailVerified: true,
        username: true,
        displayName: true,
        fullName: true,
        isDeactivated: true,
        updatedAt: true,
      },
    });
    if (!user || user.isDeactivated) {
      return null;
    }
    return {
      email: user.email,
      email_verified: user.emailVerified,
      preferred_username: user.username,
      name: user.displayName ?? user.fullName ?? user.username,
      updated_at: Math.floor(user.updatedAt.getTime() / 1000),
    };
  }
}
