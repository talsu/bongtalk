import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.module';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';
import {
  SESSION_COMPROMISED,
  SessionCompromisedEvent,
} from '../events/session-compromised.event';

export type AccessTokenPayload = {
  sub: string;
  type: 'access';
  jti: string;
  iat?: number;
  exp?: number;
  iss?: string;
  aud?: string;
};

export type RefreshRotationResult = {
  raw: string;
  familyId: string;
  parentId: string | null;
};

@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly emitter: EventEmitter2,
  ) {}

  private get accessTtlSec(): number {
    return Number(process.env.ACCESS_TOKEN_TTL ?? 900);
  }
  private get refreshTtlSec(): number {
    return Number(process.env.REFRESH_TOKEN_TTL ?? 604800);
  }
  private get issuer(): string {
    return process.env.JWT_ISSUER ?? 'qufox';
  }
  private get audience(): string {
    return process.env.JWT_AUDIENCE ?? 'qufox-web';
  }

  private hashToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  signAccess(userId: string): string {
    const payload: AccessTokenPayload = {
      sub: userId,
      type: 'access',
      jti: randomUUID(),
    };
    return this.jwt.sign(payload, {
      expiresIn: this.accessTtlSec,
      issuer: this.issuer,
      audience: this.audience,
    });
  }

  async verifyAccess(token: string): Promise<AccessTokenPayload> {
    try {
      return await this.jwt.verifyAsync<AccessTokenPayload>(token, {
        issuer: this.issuer,
        audience: this.audience,
      });
    } catch {
      throw new DomainError(ErrorCode.AUTH_INVALID_TOKEN, 'access token invalid');
    }
  }

  async issueRefreshForNewSession(
    userId: string,
    meta: { userAgent?: string; ip?: string } = {},
  ): Promise<RefreshRotationResult> {
    const raw = randomBytes(32).toString('base64url');
    const familyId = randomUUID();
    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: this.hashToken(raw),
        familyId,
        parentId: null,
        userAgent: meta.userAgent ?? null,
        ip: meta.ip ?? null,
        expiresAt: new Date(Date.now() + this.refreshTtlSec * 1000),
      },
    });
    return { raw, familyId, parentId: null };
  }

  /**
   * Rotate a refresh token. If the presented raw token:
   *   - does not exist → 401 AUTH_INVALID_TOKEN
   *   - is expired      → 401 AUTH_INVALID_TOKEN
   *   - is revoked      → REUSE attack: revoke whole family + emit event, 401 AUTH_SESSION_COMPROMISED
   *   - is valid        → mark revoked (replacedAt=now), create new token with same familyId, parent=this
   */
  async rotate(
    rawIncoming: string,
    meta: { userAgent?: string; ip?: string } = {},
  ): Promise<{ raw: string; userId: string; familyId: string }> {
    const incomingHash = this.hashToken(rawIncoming);
    const record = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: incomingHash },
    });

    if (!record) {
      throw new DomainError(ErrorCode.AUTH_INVALID_TOKEN, 'refresh token unknown');
    }
    if (record.expiresAt.getTime() <= Date.now()) {
      throw new DomainError(ErrorCode.AUTH_INVALID_TOKEN, 'refresh token expired');
    }
    if (record.revokedAt) {
      // REUSE detected — burn the whole family.
      await this.prisma.refreshToken.updateMany({
        where: { familyId: record.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      this.logger.warn(
        JSON.stringify({
          event: 'auth.session.compromised',
          userId: record.userId,
          familyId: record.familyId,
        }),
      );
      this.emitter.emit(
        SESSION_COMPROMISED,
        new SessionCompromisedEvent(record.userId, record.familyId),
      );
      throw new DomainError(
        ErrorCode.AUTH_SESSION_COMPROMISED,
        'refresh token reuse detected; session revoked',
      );
    }

    const newRaw = randomBytes(32).toString('base64url');
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.refreshToken.update({
        where: { id: record.id },
        data: { revokedAt: now, replacedAt: now },
      }),
      this.prisma.refreshToken.create({
        data: {
          userId: record.userId,
          tokenHash: this.hashToken(newRaw),
          familyId: record.familyId,
          parentId: record.id,
          userAgent: meta.userAgent ?? null,
          ip: meta.ip ?? null,
          expiresAt: new Date(Date.now() + this.refreshTtlSec * 1000),
        },
      }),
    ]);

    return { raw: newRaw, userId: record.userId, familyId: record.familyId };
  }

  async revokeRaw(rawIncoming: string): Promise<void> {
    const incomingHash = this.hashToken(rawIncoming);
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: incomingHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
