import { createHmac, timingSafeEqual } from 'node:crypto';

const SIGNATURE_PREFIX = 'sha256=';

export function verifySignature(secret: string, body: Buffer, signatureHeader: string): boolean {
  if (!signatureHeader.startsWith(SIGNATURE_PREFIX)) return false;
  const provided = signatureHeader.slice(SIGNATURE_PREFIX.length);
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  // Strict length check — timingSafeEqual throws on mismatched buffer sizes,
  // and a malformed signature should never equal a well-formed one anyway.
  if (provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

export function extractBranch(ref: string): string | null {
  const prefix = 'refs/heads/';
  if (!ref.startsWith(prefix)) return null;
  const branch = ref.slice(prefix.length);
  return branch.length > 0 ? branch : null;
}
