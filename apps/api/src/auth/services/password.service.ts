import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import zxcvbn from 'zxcvbn';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';

// Pre-computed argon2id hash of "dummy-for-timing-only" — produced once with
// the same parameters the service uses below, so the verify step takes a
// realistic amount of CPU time even when the user does not exist.
// Generated via: argon2.hash('dummy-for-timing-only', {...})
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$cXVmb3hkdW1teXNhbHRzdGExNg$BQ+iXZm7dQs2D3LZHOq2EvkKXJJchK6chKHq8hjD5tQ';

// 2 = Argon2id in @node-rs/argon2's Algorithm enum. Using the integer avoids a
// TS `isolatedModules` incompatibility with the const-enum export.
const ARGON2ID = 2 as const;

function argonOpts() {
  return {
    algorithm: ARGON2ID,
    memoryCost: Number(process.env.ARGON2_MEMORY_KIB ?? 19456),
    timeCost: Number(process.env.ARGON2_TIME_COST ?? 2),
    parallelism: Number(process.env.ARGON2_PARALLELISM ?? 1),
  };
}

@Injectable()
export class PasswordService {
  async hash(plain: string): Promise<string> {
    return hash(plain, argonOpts());
  }

  async verify(stored: string, plain: string): Promise<boolean> {
    try {
      return await verify(stored, plain);
    } catch {
      return false;
    }
  }

  // Timing-attack defense: always perform a verify step even when the account
  // does not exist, so the wire-time of success/fail/unknown-email collapses.
  async dummyVerify(plain: string): Promise<void> {
    try {
      await verify(DUMMY_HASH, plain);
    } catch {
      /* intentionally swallowed */
    }
  }

  validateStrength(plain: string, email?: string, username?: string): void {
    if (plain.length < 10) {
      throw new DomainError(ErrorCode.AUTH_WEAK_PASSWORD, 'password must be at least 10 characters');
    }
    const classes = [
      /[a-z]/.test(plain),
      /[A-Z]/.test(plain),
      /\d/.test(plain),
      /[^a-zA-Z0-9]/.test(plain),
    ].filter(Boolean).length;
    if (classes < 3) {
      throw new DomainError(
        ErrorCode.AUTH_WEAK_PASSWORD,
        'password must contain at least 3 of: lower, upper, digit, symbol',
      );
    }
    const result = zxcvbn(plain, [email ?? '', username ?? ''].filter(Boolean));
    if (result.score < 3) {
      throw new DomainError(ErrorCode.AUTH_WEAK_PASSWORD, 'password is too weak');
    }
  }
}
