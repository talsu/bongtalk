/**
 * task-038-B: magic-byte validation for uploaded objects.
 *
 * Presigned PUT lets the client send arbitrary bytes into MinIO with
 * only the mime THEY declared at presign time. On finalize we fetch
 * the first 16 bytes (`GetObject` range `bytes=0-15`, RFC-7233
 * end-inclusive → ≤16 bytes back) and compare against the expected
 * magic sequence for the declared mime. Mismatch = client lied
 * (intentionally or broken tooling) → we delete the object + reject
 * the finalize.
 *
 * Sequences:
 *   PNG  — 89 50 4E 47 0D 0A 1A 0A                   (8 bytes)
 *   GIF  — 47 49 46 38 (37|39) 61                    (6 bytes, 2 variants)
 *   JPEG — FF D8 FF                                  (3 bytes)
 *   WEBP — 52 49 46 46 __ __ __ __ 57 45 42 50       (RIFF....WEBP, 12 bytes)
 *
 * MNG is NOT accepted (explicit PNG magic only). APNG shares the PNG
 * magic so it passes the validator — browsers that support APNG will
 * animate, others render the first frame. We consider that acceptable.
 */
export type MagicSupportedMime = 'image/png' | 'image/gif' | 'image/jpeg' | 'image/webp';

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const GIF_PREFIX = [0x47, 0x49, 0x46, 0x38]; // "GIF8"
const GIF_VARIANT_SUFFIX_A = 0x37; // "7"
const GIF_VARIANT_SUFFIX_B = 0x39; // "9"
const GIF_TRAILING = 0x61; // "a"
const JPEG = [0xff, 0xd8, 0xff];
const RIFF = [0x52, 0x49, 0x46, 0x46]; // bytes 0-3
const WEBP = [0x57, 0x45, 0x42, 0x50]; // bytes 8-11

function matchesPng(buf: Uint8Array): boolean {
  if (buf.length < PNG.length) return false;
  for (let i = 0; i < PNG.length; i++) {
    if (buf[i] !== PNG[i]) return false;
  }
  return true;
}

function matchesGif(buf: Uint8Array): boolean {
  if (buf.length < 6) return false;
  for (let i = 0; i < GIF_PREFIX.length; i++) {
    if (buf[i] !== GIF_PREFIX[i]) return false;
  }
  const variant = buf[4];
  if (variant !== GIF_VARIANT_SUFFIX_A && variant !== GIF_VARIANT_SUFFIX_B) return false;
  return buf[5] === GIF_TRAILING;
}

function matchesJpeg(buf: Uint8Array): boolean {
  if (buf.length < JPEG.length) return false;
  for (let i = 0; i < JPEG.length; i++) {
    if (buf[i] !== JPEG[i]) return false;
  }
  return true;
}

function matchesWebp(buf: Uint8Array): boolean {
  // task-038 review H2 fix: WebP is `RIFF` (0-3) + size (4-7) + `WEBP`
  // (8-11). The size field is arbitrary container length, so we only
  // check the two four-byte sentinels and let the middle drift.
  if (buf.length < 12) return false;
  for (let i = 0; i < RIFF.length; i++) {
    if (buf[i] !== RIFF[i]) return false;
  }
  for (let i = 0; i < WEBP.length; i++) {
    if (buf[8 + i] !== WEBP[i]) return false;
  }
  return true;
}

/**
 * Returns true when `head` (at least 16 bytes of the object's prefix)
 * matches the magic sequence for the declared mime. Unknown mimes
 * return false — the caller should whitelist accepted mimes BEFORE
 * calling this helper, not rely on an "unknown = allow" default.
 */
export function matchesMagic(head: Uint8Array, mime: MagicSupportedMime): boolean {
  switch (mime) {
    case 'image/png':
      return matchesPng(head);
    case 'image/gif':
      return matchesGif(head);
    case 'image/jpeg':
      return matchesJpeg(head);
    case 'image/webp':
      return matchesWebp(head);
    default: {
      // task-038 review M1: exhaustiveness check. If a future mime
      // addition slips past TS narrowing, `_exhaustive` flips never →
      // MagicSupportedMime and surfaces a compile error before silent
      // false-negative ships.
      const _exhaustive: never = mime;
      void _exhaustive;
      return false;
    }
  }
}
