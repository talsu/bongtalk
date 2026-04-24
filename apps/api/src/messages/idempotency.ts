import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse the optional `Idempotency-Key` request header. Shared between
 * the workspace-scoped MessagesController and the Global DM
 * GlobalDmMessagesController so both routes enforce an identical
 * client contract.
 */
export function validateIdempotencyKey(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (!UUID_RE.test(trimmed)) {
    throw new DomainError(ErrorCode.VALIDATION_FAILED, 'Idempotency-Key must be a UUID');
  }
  return trimmed;
}
