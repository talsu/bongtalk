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
          // S77b (D14 / FR-PS-15): rotation 시점을 "마지막 활동"으로 기록한다(세션 목록 표기).
          lastSeenAt: now,
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

  // ── S77b (D14 / FR-PS-15): 세션 관리 + 자격증명 변경 보조 ────────────────────

  /**
   * 주어진 raw refresh 토큰의 familyId 를 찾는다(현재 세션 식별용). 미존재/만료 무관하게
   * 해시 매칭만 본다(쿠키가 만료 직전이라도 isCurrent 매핑은 유지). 없으면 null.
   */
  async familyIdForRaw(rawIncoming: string): Promise<string | null> {
    const record = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.hashToken(rawIncoming) },
      select: { familyId: true },
    });
    return record?.familyId ?? null;
  }

  /**
   * 활성 세션(revokedAt null · expiresAt>now) 목록을 familyId 단위로 1행씩 반환한다. 한
   * familyId 는 rotation 으로 여러 행을 가질 수 있으므로 가장 최근(createdAt desc) 행만
   * 대표로 노출한다(세션 = 패밀리). lastSeenAt 은 null 이면 createdAt 폴백 표기를 호출부가 한다.
   */
  async listSessions(
    userId: string,
    now: Date = new Date(),
  ): Promise<
    Array<{
      id: string;
      familyId: string;
      userAgent: string | null;
      ip: string | null;
      createdAt: Date;
      lastSeenAt: Date | null;
    }>
  > {
    const rows = await this.prisma.refreshToken.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        familyId: true,
        userAgent: true,
        ip: true,
        createdAt: true,
        lastSeenAt: true,
      },
    });
    // familyId 당 최신 1행만(세션 단위).
    const seen = new Set<string>();
    const sessions: Array<{
      id: string;
      familyId: string;
      userAgent: string | null;
      ip: string | null;
      createdAt: Date;
      lastSeenAt: Date | null;
    }> = [];
    for (const r of rows) {
      if (seen.has(r.familyId)) continue;
      seen.add(r.familyId);
      sessions.push(r);
    }
    return sessions;
  }

  /**
   * 개별 세션 로그아웃. sessionId(대표 행 id)로 familyId 를 찾아 본인 소유를 검증한 뒤 그
   * familyId 의 활성 토큰 전체를 revoke 한다. 본인 소유가 아니거나 없으면 SESSION_NOT_FOUND(404).
   */
  async revokeSession(userId: string, sessionId: string): Promise<void> {
    const record = await this.prisma.refreshToken.findFirst({
      where: { id: sessionId, userId },
      select: { familyId: true },
    });
    if (!record) {
      throw new DomainError(ErrorCode.SESSION_NOT_FOUND, 'session not found');
    }
    await this.prisma.refreshToken.updateMany({
      where: { familyId: record.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * 현재 세션(exceptFamilyId)을 제외한 사용자의 모든 활성 세션을 revoke 한다. exceptFamilyId
   * 가 null 이면(현재 패밀리 식별 불가) 전체를 revoke 한다.
   * @returns revoke 된 토큰 행 수.
   */
  async revokeAllExceptFamily(userId: string, exceptFamilyId: string | null): Promise<number> {
    const res = await this.prisma.refreshToken.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(exceptFamilyId ? { familyId: { not: exceptFamilyId } } : {}),
      },
      data: { revokedAt: new Date() },
    });
    return res.count;
  }
}
