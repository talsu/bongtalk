import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Socket } from 'socket.io';

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
 */
@Injectable()
export class WsAuthMiddleware {
  private readonly logger = new Logger(WsAuthMiddleware.name);

  constructor(private readonly jwt: JwtService) {}

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
