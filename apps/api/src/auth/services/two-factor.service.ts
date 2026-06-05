import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { authenticator } from 'otplib';
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
import { PasswordService } from './password.service';

// otpauth issuer 라벨(인증 앱에 표시되는 서비스명).
const TOTP_ISSUER = 'qufox';

// SF1 (security HIGH-1 / reviewer MED1): replay 차단을 위한 "마지막 사용 코드" 기록 TTL(초).
// 한 코드의 유효 윈도(현재 ±1 step = 최대 90초)보다 길게 잡아, 같은 코드가 그 윈도 안에 다시
// 제출돼도 거부한다(여러 step 에 걸쳐 유효한 코드의 재사용을 모두 차단).
const TOTP_REPLAY_TTL_SEC = 90;

// SF1 (security HIGH-1): ±1 step(±30초) 드리프트 허용 — usability. 시간 동기 오차/입력 지연을
// 수용하되, 아래 replay 기록이 같은 코드의 재제출을 막아 윈도 확대로 인한 replay 위험을 상쇄한다.
authenticator.options = { window: 1 };

// Redis setup 키 — 사용자당 단일키(재호출 시 DEL 후 재발급). TTL 10분.
function setupKey(userId: string): string {
  return `totp:setup:${userId}`;
}
// SF1: 사용자별 "마지막 성공 코드" 키. verify/disable 성공 직후 SET, TTL 90초.
function lastCodeKey(userId: string): string {
  return `totp:last:${userId}`;
}

/**
 * S77b (D14 / FR-PS-15·20): TOTP 2FA — setup → verify → disable.
 *
 * 사용자 결정(project_s77_security_decisions):
 *   - 시크릿 암호화 = AES-256-GCM(CryptoService · APP_ENCRYPTION_KEY). 키 미설정 시 모든 2FA
 *     엔드포인트는 graceful 503(ENCRYPTION_UNAVAILABLE) — assertEncryptionAvailable() 가 게이트.
 *   - 라이브러리 = otplib(RFC6238).
 *   - setup 시크릿은 DB 가 아니라 Redis `totp:setup:{userId}` 단일키에 10분 TTL 로 보관하고,
 *     verify 성공 시에만 암호화해 영속한다(미완료 setup 이 DB 를 오염시키지 않게).
 *
 * ★ S77b fix-forward (PF1 / perf SERIOUS · reviewer MED2): 백업코드 해싱은 종전 bcryptjs(순수 JS,
 *   cost12 × 10 = 이벤트루프 ~6s 블로킹)에서 PasswordService(@node-rs/argon2 · native · libuv
 *   threadpool 비블로킹)로 교체했다. 사용자 결정(bcryptjs)에서의 의도적 일탈이며 근거는:
 *     ① perf SERIOUS(이벤트루프 멀티-초 점유 — 단일 요청이 전 노드를 마비),
 *     ② argon2 는 이미 동일 NAS(kernel 4.4)에서 password 해셔로 검증된 native 해셔라
 *        "native-addon 회피" 우려가 무효,
 *     ③ reviewer 권고. 백업코드는 40bit hex 단발코드라 argon2 직접 해싱으로 충분히 안전.
 *
 * ★ SF1 (replay 차단): verify/disable 의 코드 검증은 assertTotpCode() 로 일원화해, 성공 시
 *   `totp:last:{userId}` 에 사용 코드를 90초 SET 하고 이후 같은 코드면 TOTP_INVALID 로 거부한다
 *   (otplib window=1 로 확장된 윈도 안의 재제출도 막힌다).
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
    private readonly passwords: PasswordService,
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

  /**
   * SF1: 제출 코드를 시크릿과 대조하고 replay 를 차단한다. 불일치/재사용 모두 TOTP_INVALID(403).
   *   1) `totp:last:{userId}` 에 같은 코드가 남아 있으면(아직 90초 TTL 내) 재사용 → 거부.
   *   2) authenticator.check(window=1) 로 시크릿과 대조 — 실패 시 거부.
   *   3) 성공이면 코드를 사용 처리로 90초 SET 한다(이후 같은 코드 재제출 거부).
   * ★ 코드/시크릿은 로그하지 않는다.
   */
  private async assertTotpCode(userId: string, code: string, secret: string): Promise<void> {
    const last = await this.redis.get(lastCodeKey(userId));
    if (last !== null && last === code) {
      throw new DomainError(ErrorCode.TOTP_INVALID, 'invalid TOTP code');
    }
    if (!authenticator.check(code, secret)) {
      throw new DomainError(ErrorCode.TOTP_INVALID, 'invalid TOTP code');
    }
    // 성공한 코드를 소진 처리(90초 — 유효 윈도보다 길게).
    await this.redis.set(lastCodeKey(userId), code, 'EX', TOTP_REPLAY_TTL_SEC);
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
   * verify: Redis 의 setup 시크릿과 제출 코드를 대조한다(SF1 replay 차단 포함). 성공 시
   * RF1(reviewer M1) TOCTOU 방어를 위해 단일 트랜잭션 안에서 **조건부** updateMany 로
   *   - totpEnabled=false 인 경우에만 시크릿 암호화 영속 + totpEnabled=true (count===0 이면
   *     동시에 다른 verify 가 이미 활성화한 것 → TOTP_ALREADY_ENABLED, 백업코드 INSERT 전 중단)
   *   - 백업코드 10개(argon2 해싱·BackupCode 행) INSERT
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
    // SF1: 코드 검증 + replay 차단(성공 시 90초 소진).
    await this.assertTotpCode(userId, code, secret);

    // 시크릿 암호화 — 평문은 영속하지 않는다.
    const totpSecretEnc = this.crypto.encrypt(secret);

    // PF1: 백업코드 10개 생성 + argon2 해싱(native · 비블로킹).
    const plainCodes = Array.from({ length: TOTP_BACKUP_CODE_COUNT }, () => generateBackupCode());
    const hashed = await Promise.all(plainCodes.map((c) => this.passwords.hash(c)));

    await this.prisma.$transaction(async (tx) => {
      // RF1 (TOCTOU): tx 밖 getStatus 와 tx 안 update 사이의 경합을 막기 위해, totpEnabled=false
      // 인 행만 조건부로 업데이트한다. count===0 이면 다른 verify 가 이미 활성화한 것이므로
      // 백업코드 createMany 이전에 중단해 한 set 만 일관되게 영속한다.
      const res = await tx.user.updateMany({
        where: { id: userId, totpEnabled: false },
        data: { totpSecretEnc, totpEnabled: true },
      });
      if (res.count === 0) {
        throw new DomainError(ErrorCode.TOTP_ALREADY_ENABLED, '2FA is already enabled');
      }
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
   * disable: 비번 + TOTP 코드 동시 검증(SF1 replay 차단 포함) 후 2FA 를 해제한다
   * (totpSecretEnc/totpEnabled 해제 + BackupCode 삭제). 코드 누락은 컨트롤러가 TOTP_CODE_REQUIRED
   * 로 선거부하므로 여기선 검증만. 미활성 상태면 409 TOTP_NOT_ENABLED. 코드 불일치/재사용은 403
   * TOTP_INVALID.
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
      this.logger.error(JSON.stringify({ event: 'totp.disable.decrypt_failed', userId }));
      throw new DomainError(ErrorCode.INTERNAL, 'failed to verify 2FA');
    }
    // SF1: 코드 검증 + replay 차단(성공 시 90초 소진 — disable 직후 동일 코드 재사용 차단).
    await this.assertTotpCode(userId, totpCode, secret);

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { totpSecretEnc: null, totpEnabled: false },
      });
      await tx.backupCode.deleteMany({ where: { userId } });
    });
  }

  /**
   * SF2·SF3 (security HIGH-2·3): 자격증명 변경(이메일/비밀번호) 시 2FA 활성 사용자의 TOTP 재확인.
   * AccountSecurityService 가 호출한다. totpEnabled=false 면 즉시 통과(no-op). 활성인데 코드가
   * 없으면 TOTP_CODE_REQUIRED(403), 불일치/재사용이면 TOTP_INVALID(403). 검증 성공 시 SF1 의
   * replay 기록을 갱신해 같은 코드의 연쇄 자격증명 변경을 막는다.
   */
  async assertCredentialChangeTotp(userId: string, totpCode: string | undefined): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { totpEnabled: true, totpSecretEnc: true },
    });
    if (!user?.totpEnabled || !user.totpSecretEnc) {
      return; // 2FA 미활성 — 추가 확인 없음.
    }
    this.assertEncryptionAvailable();
    if (!totpCode) {
      throw new DomainError(
        ErrorCode.TOTP_CODE_REQUIRED,
        'a valid TOTP code is required for this change while 2FA is enabled',
      );
    }
    let secret: string;
    try {
      secret = this.crypto.decrypt(user.totpSecretEnc);
    } catch {
      this.logger.error(JSON.stringify({ event: 'totp.credential_change.decrypt_failed', userId }));
      throw new DomainError(ErrorCode.INTERNAL, 'failed to verify 2FA');
    }
    await this.assertTotpCode(userId, totpCode, secret);
  }
}

/** 백업코드 평문 1개 — 소문자 hex 10자(추측 불가). 표시/입력 편의를 위해 hex 만 쓴다. */
function generateBackupCode(): string {
  // hex 라 길이의 절반 바이트면 충분(10자 → 5바이트).
  return randomBytes(Math.ceil(TOTP_BACKUP_CODE_LENGTH / 2))
    .toString('hex')
    .slice(0, TOTP_BACKUP_CODE_LENGTH);
}
