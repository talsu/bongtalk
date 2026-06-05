import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { authenticator } from 'otplib';
import { hash as bcryptHash } from 'bcryptjs';
import { toDataURL as qrToDataURL } from 'qrcode';
import type Redis from 'ioredis';
import {
  TOTP_BACKUP_CODE_COUNT,
  TOTP_BACKUP_CODE_LENGTH,
  TOTP_SETUP_TTL_SEC,
  type TotpSetupResponse,
  type TotpVerifyResponse,
} from '@qufox/shared-types';
import { PrismaService } from '../../prisma/prisma.module';
import { REDIS } from '../../redis/redis.module';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';
import { CryptoService } from './crypto.service';

// bcrypt cost ≥ 12 (PLAN). 백업코드 10개를 verify 시 한 번에 해싱하므로 12 로 둔다(요청당 1회).
const BCRYPT_COST = 12;
// otpauth issuer 라벨(인증 앱에 표시되는 서비스명).
const TOTP_ISSUER = 'qufox';
// Redis setup 키 — 사용자당 단일키(재호출 시 DEL 후 재발급). TTL 10분.
function setupKey(userId: string): string {
  return `totp:setup:${userId}`;
}

/**
 * S77b (D14 / FR-PS-15·20): TOTP 2FA — setup → verify → disable.
 *
 * 사용자 결정(project_s77_security_decisions):
 *   - 시크릿 암호화 = AES-256-GCM(CryptoService · APP_ENCRYPTION_KEY). 키 미설정 시 모든 2FA
 *     엔드포인트는 graceful 503(ENCRYPTION_UNAVAILABLE) — assertEncryptionAvailable() 가 게이트.
 *   - 라이브러리 = otplib(RFC6238). 백업코드 = bcryptjs(cost≥12).
 *   - setup 시크릿은 DB 가 아니라 Redis `totp:setup:{userId}` 단일키에 10분 TTL 로 보관하고,
 *     verify 성공 시에만 암호화해 영속한다(미완료 setup 이 DB 를 오염시키지 않게).
 *
 * ★ 시크릿/백업코드 평문을 절대 로그하지 않는다(setup 응답·verify 응답으로만 1회 전달).
 */
@Injectable()
export class TwoFactorService {
  private readonly logger = new Logger(TwoFactorService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly crypto: CryptoService,
  ) {}

  /** 키 미설정이면 ENCRYPTION_UNAVAILABLE(503) 을 던진다(크래시 금지 — 모든 2FA 진입점에서 선행). */
  private assertEncryptionAvailable(): void {
    if (!this.crypto.isAvailable()) {
      throw new DomainError(
        ErrorCode.ENCRYPTION_UNAVAILABLE,
        '2FA is temporarily unavailable (server encryption key not configured)',
      );
    }
  }

  async getStatus(userId: string): Promise<{ totpEnabled: boolean }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { totpEnabled: true },
    });
    return { totpEnabled: user?.totpEnabled ?? false };
  }

  /**
   * setup: 새 base32 시크릿을 생성해 Redis 단일키(TTL 10분)에 SET 하고 otpauth URI + base32 +
   * QR data-URI 를 반환한다. 재호출 시 기존 키를 DEL 후 재발급한다(단일키 — 마지막 setup 만 유효).
   * 이미 2FA 활성 상태면 409 TOTP_ALREADY_ENABLED.
   */
  async setup(userId: string, accountLabel: string): Promise<TotpSetupResponse> {
    this.assertEncryptionAvailable();
    const status = await this.getStatus(userId);
    if (status.totpEnabled) {
      throw new DomainError(ErrorCode.TOTP_ALREADY_ENABLED, '2FA is already enabled');
    }

    const secret = authenticator.generateSecret(); // base32.
    const key = setupKey(userId);
    // 단일키 — 재호출 시 기존 시크릿을 버리고 새 시크릿으로 덮어쓴다(SET … EX 가 자동 대체하나,
    // 명시적 DEL 로 TTL 도 깔끔히 재설정한다).
    await this.redis.del(key);
    await this.redis.set(key, secret, 'EX', TOTP_SETUP_TTL_SEC);

    const otpauthUri = authenticator.keyuri(accountLabel, TOTP_ISSUER, secret);
    const qrDataUri = await qrToDataURL(otpauthUri, { errorCorrectionLevel: 'M', margin: 1 });
    return { otpauthUri, secret, qrDataUri };
  }

  /**
   * verify: Redis 의 setup 시크릿과 제출 코드를 대조한다. 성공 시 단일 트랜잭션으로
   *   - 시크릿을 암호화해 totpSecretEnc 영속 + totpEnabled=true
   *   - 백업코드 10개 생성(bcrypt 해싱·BackupCode 행) + 기존 백업코드 정리
   * 후 평문 백업코드 10개를 1회 반환한다(재조회 불가). setup 미존재/만료 → TOTP_INVALID.
   */
  async verify(userId: string, code: string): Promise<TotpVerifyResponse> {
    this.assertEncryptionAvailable();
    const status = await this.getStatus(userId);
    if (status.totpEnabled) {
      throw new DomainError(ErrorCode.TOTP_ALREADY_ENABLED, '2FA is already enabled');
    }

    const key = setupKey(userId);
    const secret = await this.redis.get(key);
    if (!secret) {
      // setup 미진행/만료 — 무효한 verify 로 취급한다(시크릿 미존재를 누출하지 않음).
      throw new DomainError(ErrorCode.TOTP_INVALID, 'invalid or expired TOTP setup');
    }
    if (!authenticator.check(code, secret)) {
      throw new DomainError(ErrorCode.TOTP_INVALID, 'invalid TOTP code');
    }

    // 시크릿 암호화 — 평문은 영속하지 않는다.
    const totpSecretEnc = this.crypto.encrypt(secret);

    // 백업코드 10개 생성 + bcrypt 해싱.
    const plainCodes = Array.from({ length: TOTP_BACKUP_CODE_COUNT }, () => generateBackupCode());
    const hashed = await Promise.all(plainCodes.map((c) => bcryptHash(c, BCRYPT_COST)));

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { totpSecretEnc, totpEnabled: true },
      });
      // 재설정 대비 기존 백업코드를 정리한 뒤 새 10행을 INSERT(멱등).
      await tx.backupCode.deleteMany({ where: { userId } });
      await tx.backupCode.createMany({
        data: hashed.map((codeHash) => ({ id: randomUUID(), userId, codeHash })),
      });
    });

    // 1회용 시크릿은 더 이상 필요 없으므로 Redis 키를 비운다.
    await this.redis.del(key);

    // ★ 평문 백업코드는 로그하지 않는다 — 응답으로만 1회 전달.
    return { totpEnabled: true, backupCodes: plainCodes };
  }

  /**
   * disable: 비번 + TOTP 코드 동시 검증 후 2FA 를 해제한다(totpSecretEnc/totpEnabled 해제 +
   * BackupCode 삭제). 코드 누락은 컨트롤러가 TOTP_CODE_REQUIRED 로 선거부하므로 여기선 검증만.
   * 미활성 상태면 409 TOTP_NOT_ENABLED. 코드 불일치면 403 TOTP_INVALID.
   */
  async disable(userId: string, totpCode: string): Promise<void> {
    this.assertEncryptionAvailable();
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { totpEnabled: true, totpSecretEnc: true },
    });
    if (!user?.totpEnabled || !user.totpSecretEnc) {
      throw new DomainError(ErrorCode.TOTP_NOT_ENABLED, '2FA is not enabled');
    }

    let secret: string;
    try {
      secret = this.crypto.decrypt(user.totpSecretEnc);
    } catch {
      // 복호화 실패(키 변경/변조)는 도메인 거부가 아닌 서버 오류 — 시크릿은 로그하지 않는다.
      this.logger.error(
        JSON.stringify({ event: 'totp.disable.decrypt_failed', userId }),
      );
      throw new DomainError(ErrorCode.INTERNAL, 'failed to verify 2FA');
    }
    if (!authenticator.check(totpCode, secret)) {
      throw new DomainError(ErrorCode.TOTP_INVALID, 'invalid TOTP code');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { totpSecretEnc: null, totpEnabled: false },
      });
      await tx.backupCode.deleteMany({ where: { userId } });
    });
  }
}

/** 백업코드 평문 1개 — 소문자 hex 10자(추측 불가). 표시/입력 편의를 위해 hex 만 쓴다. */
function generateBackupCode(): string {
  // hex 라 길이의 절반 바이트면 충분(10자 → 5바이트).
  return randomBytes(Math.ceil(TOTP_BACKUP_CODE_LENGTH / 2))
    .toString('hex')
    .slice(0, TOTP_BACKUP_CODE_LENGTH);
}
