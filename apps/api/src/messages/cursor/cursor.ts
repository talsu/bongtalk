import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';

/**
 * Opaque pagination cursor. Wire format is `base64url(JSON.stringify({t,id}))`
 * so the client treats the string as a token and cannot forge non-matching
 * rows — only valid `(createdAt, id)` tuples survive the validator.
 *
 * The SQL side uses PostgreSQL row-value comparison:
 *   WHERE ("createdAt", id) < ($1, $2)
 * to keep the read path on the `(channelId, createdAt, id)` index.
 */
export type CursorPayload = { t: string; id: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isIsoDateTime(value: string): boolean {
  if (typeof value !== 'string') return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms);
}

export function encodeCursor(payload: CursorPayload): string {
  const json = JSON.stringify({ t: payload.t, id: payload.id });
  return Buffer.from(json, 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): CursorPayload {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) {
    throw new DomainError(ErrorCode.MESSAGE_CURSOR_INVALID, 'cursor empty or too long');
  }
  let json: string;
  try {
    json = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    throw new DomainError(ErrorCode.MESSAGE_CURSOR_INVALID, 'cursor base64 decode failed');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new DomainError(ErrorCode.MESSAGE_CURSOR_INVALID, 'cursor payload is not JSON');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new DomainError(ErrorCode.MESSAGE_CURSOR_INVALID, 'cursor payload is not an object');
  }
  const { t, id } = parsed as Record<string, unknown>;
  if (typeof t !== 'string' || !isIsoDateTime(t)) {
    throw new DomainError(ErrorCode.MESSAGE_CURSOR_INVALID, 'cursor.t must be ISO date-time');
  }
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    throw new DomainError(ErrorCode.MESSAGE_CURSOR_INVALID, 'cursor.id must be UUID');
  }
  return { t, id };
}

/** Build a cursor for a message row — caller-friendly helper. */
export function cursorFor(row: { createdAt: Date | string; id: string }): string {
  const t = typeof row.createdAt === 'string' ? row.createdAt : row.createdAt.toISOString();
  return encodeCursor({ t, id: row.id });
}
