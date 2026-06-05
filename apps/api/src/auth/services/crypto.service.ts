import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';

/**
 * S77b (D14 / FR-PS-15): 대칭 암호화 서비스(AES-256-GCM).
 *
 * 사용자 결정(project_s77_security_decisions): TOTP 시크릿은 평문으로 저장하지 않고
 * `APP_ENCRYPTION_KEY`(32바이트 base64) 로 AES-256-GCM 암호화해 영속한다. 암호문 포맷은
 * `iv:tag:ciphertext` 를 각각 base64 로 인코딩해 `:` 로 결합한 단일 문자열이다.
 *
 *   encrypt(plain) → "<iv b64>:<authTag b64>:<ciphertext b64>"
 *   decrypt(blob)  → plain (위 포맷 역)
 *
 * ★ 보안 불변식:
 *   - 키/평문/암호문을 절대 로그하지 않는다(에러 메시지에도 미포함).
 *   - 키 미설정/형식오류 시 ENCRYPTION_UNAVAILABLE(503) 을 던져 호출부가 graceful 503 으로
 *     처리하게 한다(크래시 금지). 부트 시점에 키를 캐싱하지 않고 매 호출에 읽어, 키가 나중에
 *     주입돼도(또는 빠져도) 즉시 반영된다(테스트 격리에도 유리).
 *   - GCM authTag 검증 실패(변조/잘못된 키)는 decrypt 가 throw → 호출부가 INTERNAL 로 흡수.
 */
@Injectable()
export class CryptoService {
  private static readonly ALGO = 'aes-256-gcm';
  private static readonly IV_BYTES = 12; // GCM 권장 96-bit nonce.
  private static readonly KEY_BYTES = 32; // AES-256.

  /**
   * APP_ENCRYPTION_KEY 가 설정돼 있고 32바이트 base64 로 디코드되는지 여부. 2FA 엔드포인트가
   * 본격 처리 전에 호출해 graceful 503(ENCRYPTION_UNAVAILABLE)으로 분기하는 데 쓴다.
   */
  isAvailable(): boolean {
    try {
      this.readKey();
      return true;
    } catch {
      return false;
    }
  }

  /** APP_ENCRYPTION_KEY 를 32바이트 Buffer 로 읽는다. 미설정/형식오류 시 503 을 던진다. */
  private readKey(): Buffer {
    const raw = (process.env.APP_ENCRYPTION_KEY ?? '').trim();
    if (raw.length === 0) {
      throw new DomainError(
        ErrorCode.ENCRYPTION_UNAVAILABLE,
        'encryption key is not configured (APP_ENCRYPTION_KEY)',
      );
    }
    let key: Buffer;
    try {
      key = Buffer.from(raw, 'base64');
    } catch {
      throw new DomainError(
        ErrorCode.ENCRYPTION_UNAVAILABLE,
        'encryption key is malformed (expected base64)',
      );
    }
    if (key.length !== CryptoService.KEY_BYTES) {
      // ★ 키 자체는 로그하지 않는다 — 길이만 노출.
      throw new DomainError(
        ErrorCode.ENCRYPTION_UNAVAILABLE,
        `encryption key must decode to ${CryptoService.KEY_BYTES} bytes (got ${key.length})`,
      );
    }
    return key;
  }

  /** 평문을 AES-256-GCM 으로 암호화해 `iv:tag:ciphertext`(각 base64) 단일 문자열로 반환한다. */
  encrypt(plain: string): string {
    const key = this.readKey();
    const iv = randomBytes(CryptoService.IV_BYTES);
    const cipher = createCipheriv(CryptoService.ALGO, key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
  }

  /** `iv:tag:ciphertext`(각 base64) 를 복호화해 평문으로 되돌린다. 형식오류/변조 시 throw. */
  decrypt(blob: string): string {
    const key = this.readKey();
    const parts = blob.split(':');
    if (parts.length !== 3) {
      throw new Error('malformed ciphertext (expected iv:tag:ciphertext)');
    }
    const [ivB64, tagB64, ctB64] = parts;
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const ciphertext = Buffer.from(ctB64, 'base64');
    const decipher = createDecipheriv(CryptoService.ALGO, key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plain.toString('utf8');
  }
}
