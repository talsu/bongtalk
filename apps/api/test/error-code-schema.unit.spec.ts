/**
 * Task-015-A (014-follow-3 closure): regression guard for the
 * backend enum ↔ shared-types ErrorCodeSchema drift that let 8
 * attachment/visibility/invite/forbidden codes escape the wire
 * contract unchecked. If anyone adds an enum value without mirroring
 * it into shared-types, this spec fires.
 */
import { describe, expect, it } from 'vitest';
import { ErrorCodeSchema } from '@qufox/shared-types';
import { ErrorCode, ERROR_CODE_HTTP_STATUS } from '../src/common/errors/error-code.enum';

describe('ErrorCode ↔ shared-types ErrorCodeSchema parity', () => {
  it('every backend enum value is present in the shared-types schema', () => {
    const sharedValues = new Set(ErrorCodeSchema.options);
    const missing: string[] = [];
    for (const val of Object.values(ErrorCode)) {
      if (!sharedValues.has(val as (typeof ErrorCodeSchema)['options'][number])) {
        missing.push(val);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every backend enum value has an HTTP status mapping', () => {
    for (const val of Object.values(ErrorCode)) {
      expect(ERROR_CODE_HTTP_STATUS[val as ErrorCode]).toBeTypeOf('number');
    }
  });
});
