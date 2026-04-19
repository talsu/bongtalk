import { Prisma } from '@prisma/client';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';

/** Smallest allowed gap between two positions before we refuse to subdivide.
 *  Decimal(20,10) gives us 10 fractional digits — anything below 1e-9 forces
 *  a position-normalize batch, tracked as TODO(task-020). */
const MIN_GAP = new Prisma.Decimal('0.000000001');

/** Default stride used when the list is empty or when appending past the tail. */
export const POSITION_STRIDE = new Prisma.Decimal('1000000000');

/**
 * Compute a fractional position strictly between `prev` and `next`.
 *
 *   calcBetween(null, first)     → first - STRIDE   (prepend)
 *   calcBetween(last, null)      → last  + STRIDE   (append)
 *   calcBetween(null, null)      → STRIDE           (first ever row)
 *   calcBetween(a, b)            → (a + b) / 2      (midpoint)
 *
 * Throws `CHANNEL_POSITION_INVALID` when the gap between `prev` and `next`
 * is smaller than MIN_GAP — the caller should trigger a normalize pass.
 */
export function calcBetween(
  prev: Prisma.Decimal | string | null | undefined,
  next: Prisma.Decimal | string | null | undefined,
): Prisma.Decimal {
  const p = prev != null ? new Prisma.Decimal(prev) : null;
  const n = next != null ? new Prisma.Decimal(next) : null;

  if (p === null && n === null) return POSITION_STRIDE;
  if (p === null && n !== null) return n.minus(POSITION_STRIDE);
  if (p !== null && n === null) return p.plus(POSITION_STRIDE);

  // Both present.
  const gap = n!.minus(p!);
  if (gap.lte(MIN_GAP)) {
    throw new DomainError(
      ErrorCode.CHANNEL_POSITION_INVALID,
      'position gap exhausted — clients should request a normalize pass',
    );
  }
  return p!.plus(n!).dividedBy(2);
}
