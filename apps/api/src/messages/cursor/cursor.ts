import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';

/**
 * Opaque pagination cursor (S03 / FR-MSG-21).
 *
 * Wire format is `base64url(JSON.stringify({ id, createdAt }))` so the client
 * treats the string as an opaque token and cannot forge non-matching rows —
 * only valid `(createdAt, id)` tuples survive the validator.
 *
 * The SQL side uses PostgreSQL row-value comparison:
 *   WHERE ("createdAt", id) < ($1, $2::uuid)
 * to keep the read path on the `(channelId, createdAt, id)` index.
 *
 * expand-contract: the canonical FR-MSG-21 payload key is `createdAt`. The
 * legacy slice shipped `{ t, id }` tokens, so `decodeCursor` accepts BOTH on
 * the read path (a live client may still hold a `{ t, id }` token across the
 * deploy) but `encodeCursor` only ever emits the canonical `{ id, createdAt }`
 * form.
 *
 * NOTE(S03 review MAJOR #2 / SEC cuid2): `id` is UUID-ONLY. `Message.id` is
 * physically `@db.Uuid`, the read path binds `$4::uuid` (a cuid2 would throw a
 * Postgres cast error), and `?around=` is `z.string().uuid()`. The earlier
 * cuid2 widening here was premature — it let a cuid2 cursor pass JS validation
 * then die at the `::uuid` cast. The S01 PK→cuid2 transition (if it ever
 * lands) must re-loosen BOTH this validator AND the SQL cast together; until
 * then the cursor stays uuid-only so JS validation and SQL agree. (The mrkdwn
 * `mentions` cuid2 tolerance is a SEPARATE parser concern and is unaffected.)
 */
export type CursorPayload = { id: string; createdAt: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// FR-MSG-21: ISO-8601 instant with explicit zone — matches shared-types'
// `z.string().datetime()`. The earlier `Date.parse()` check accepted
// engine-specific junk ("Jan 1, 2025", "2025/01/01") that then bound into a
// `$3::timestamp` cast (SEC-05 advisory); a strict regex keeps JS validation
// and the SQL contract aligned and the row range deterministic.
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function isIsoDateTime(value: string): boolean {
  if (typeof value !== 'string') return false;
  if (!ISO_DATETIME_RE.test(value)) return false;
  // Reject calendar-invalid instants (e.g. 2025-13-40T..) that pass the shape.
  return Number.isFinite(Date.parse(value));
}

function isValidId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function encodeCursor(payload: CursorPayload): string {
  // Canonical FR-MSG-21 order/keys: { id, createdAt }.
  const json = JSON.stringify({ id: payload.id, createdAt: payload.createdAt });
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
    throw new DomainError(ErrorCode.MESSAGE_CURSOR_INVALID, 'cursor base64url decode failed');
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
  const obj = parsed as Record<string, unknown>;
  // Accept canonical `createdAt`, falling back to the legacy `t` key.
  const createdAt = typeof obj.createdAt === 'string' ? obj.createdAt : obj.t;
  const id = obj.id;
  if (typeof createdAt !== 'string' || !isIsoDateTime(createdAt)) {
    throw new DomainError(
      ErrorCode.MESSAGE_CURSOR_INVALID,
      'cursor.createdAt must be ISO date-time',
    );
  }
  if (!isValidId(id)) {
    throw new DomainError(ErrorCode.MESSAGE_CURSOR_INVALID, 'cursor.id must be a uuid');
  }
  return { id, createdAt };
}

/** Build a cursor for a message row — caller-friendly helper. */
export function cursorFor(row: { createdAt: Date | string; id: string }): string {
  const createdAt = typeof row.createdAt === 'string' ? row.createdAt : row.createdAt.toISOString();
  return encodeCursor({ id: row.id, createdAt });
}
