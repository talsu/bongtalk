import { Inject, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Socket } from 'socket.io';
import type Redis from 'ioredis';
import { PrismaService } from '../../prisma/prisma.module';
import { REDIS } from '../../redis/redis.module';

export type WsUserPayload = {
  userId: string;
  email?: string;
  username?: string;
  sessionId: string;
};

/**
 * Verifies the JWT passed via `auth.accessToken` on the Socket.IO handshake.
 * On success the payload is written to `socket.data` so downstream handlers
 * never re-verify; on failure `next(err)` causes the client to receive
 * `connect_error` and the socket never enters the server's connected pool.
 *
 * S77c fix-forward (CF1 · reviewer B1 · perf MODERATE): JWT 서명만 검증하면 비활성 계정의
 * 살아있는 access token 으로 새 WS 재연결이 가능해(HTTP 만 JwtStrategy 가 차단) fan-out/presence/
 * typing 을 계속 수신한다. 핸드셰이크에서 JwtStrategy 와 동일한 이중검사를 수행한다:
 *   ① Redis `deactivated:{userId}` GET(즉시 차단 · TTL 15m) → 적중 시 거부(DB 조회 생략).
 *   ② DB isDeactivated=true(블랙리스트 TTL 만료 후에도 영속 출처) → 적중 시 거부.
 * 어느 한쪽이라도 적중하면 `next(new Error('auth:deactivated'))` 로 connect_error 를 던져 소켓이
 * connected pool 에 진입하지 못하게 한다.
 */
@Injectable()
export class WsAuthMiddleware {
  private readonly logger = new Logger(WsAuthMiddleware.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  middleware(): (socket: Socket, next: (err?: Error) => void) => void {
    return async (socket, next) => {
      try {
        const token = pickToken(socket);
        if (!token) return next(new Error('auth:missing_token'));

        const payload = await this.jwt.verifyAsync<{
          sub: string;
          type?: string;
          email?: string;
          username?: string;
        }>(token, {
          secret: process.env.JWT_ACCESS_SECRET ?? '',
          issuer: process.env.JWT_ISSUER ?? 'qufox',
          audience: process.env.JWT_AUDIENCE ?? 'qufox-web',
        });
        if (payload.type && payload.type !== 'access') {
          return next(new Error('auth:not_access_token'));
        }
        // CF1: JwtStrategy 와 동일 이중검사 — 비활성 계정의 살아있는 토큰으로도 WS 재연결을 막는다.
        // ① Redis 블랙리스트 적중 시 즉시 거부(DB 조회 생략). 키 형식은 account-lifecycle.service 의
        //    deactivatedKey 와 동일하다(`deactivated:{userId}`). account-lifecycle.service →
        //    RealtimeGateway → ws-auth.middleware 정적 import 순환을 피하려고 키를 인라인한다.
        const blacklisted = await this.redis.get(`deactivated:${payload.sub}`);
        if (blacklisted) {
          this.logger.debug(`[ws] handshake rejected: deactivated(redis) user=${payload.sub}`);
          return next(new Error('auth:deactivated'));
        }
        // ② DB isDeactivated 영속 출처(TTL 만료 후에도 차단).
        const row = await this.prisma.user.findUnique({
          where: { id: payload.sub },
          select: { isDeactivated: true },
        });
        if (!row) return next(new Error('auth:invalid_token'));
        if (row.isDeactivated) {
          this.logger.debug(`[ws] handshake rejected: deactivated(db) user=${payload.sub}`);
          return next(new Error('auth:deactivated'));
        }
        const user: WsUserPayload = {
          userId: payload.sub,
          email: payload.email,
          username: payload.username,
          // session is the socket.id itself — unique per connection, rotates
          // naturally on reconnect.
          sessionId: socket.id,
        };
        socket.data.user = user;
        next();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.debug(`[ws] handshake rejected: ${msg}`);
        next(new Error('auth:invalid_token'));
      }
    };
  }
}

function pickToken(socket: Socket): string | null {
  const auth = socket.handshake.auth as { accessToken?: string } | undefined;
  if (auth?.accessToken && typeof auth.accessToken === 'string') return auth.accessToken;
  const header = socket.handshake.headers['authorization'];
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice('Bearer '.length);
  }
  return null;
}
