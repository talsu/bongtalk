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
// S54 (FR-AM-06): MagicSupportedMime 확장 — PDF / MP4 / 오디오(mpeg·ogg·wav·flac)
// 시그니처 추가. complete 경로(8192B prefix)에서 declared MIME ↔ 실 바이트 교차검증에
// 쓴다. zip(PK 헤더)도 추가해 zip↔jar/apk 위장 교차검증을 지원한다.
export type MagicSupportedMime =
  | 'image/png'
  | 'image/gif'
  | 'image/jpeg'
  | 'image/webp'
  | 'application/pdf'
  | 'video/mp4'
  | 'audio/mpeg'
  | 'audio/ogg'
  | 'audio/wav'
  | 'audio/flac'
  | 'application/zip';

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const GIF_PREFIX = [0x47, 0x49, 0x46, 0x38]; // "GIF8"
const GIF_VARIANT_SUFFIX_A = 0x37; // "7"
const GIF_VARIANT_SUFFIX_B = 0x39; // "9"
const GIF_TRAILING = 0x61; // "a"
const JPEG = [0xff, 0xd8, 0xff];
const RIFF = [0x52, 0x49, 0x46, 0x46]; // bytes 0-3
const WEBP = [0x57, 0x45, 0x42, 0x50]; // bytes 8-11
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
const FTYP = [0x66, 0x74, 0x79, 0x70]; // "ftyp" — bytes 4-7 of MP4/ISO-BMFF
const ID3 = [0x49, 0x44, 0x33]; // "ID3" — MP3 with ID3 tag
const MP3_FRAME_SYNC = 0xff; // MP3 frame sync byte 0 (byte 1 high bits 0xE0)
const OGG = [0x4f, 0x67, 0x67, 0x53]; // "OggS"
const WAVE = [0x57, 0x41, 0x56, 0x45]; // "WAVE" — bytes 8-11 of RIFF/WAVE
const FLAC = [0x66, 0x4c, 0x61, 0x43]; // "fLaC"
const PK_ZIP = [0x50, 0x4b]; // "PK" — zip local file header (also jar/apk/office)

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

function startsWith(buf: Uint8Array, sig: number[]): boolean {
  if (buf.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (buf[i] !== sig[i]) return false;
  }
  return true;
}

function matchesPdf(buf: Uint8Array): boolean {
  return startsWith(buf, PDF);
}

function matchesMp4(buf: Uint8Array): boolean {
  // ISO-BMFF: bytes 4-7 = "ftyp" (bytes 0-3 are the box size, arbitrary).
  if (buf.length < 8) return false;
  for (let i = 0; i < FTYP.length; i++) {
    if (buf[4 + i] !== FTYP[i]) return false;
  }
  return true;
}

function matchesMpegAudio(buf: Uint8Array): boolean {
  // MP3 either starts with an "ID3" tag or a raw frame sync (0xFF 0xEx/0xFx).
  if (startsWith(buf, ID3)) return true;
  if (buf.length < 2) return false;
  return buf[0] === MP3_FRAME_SYNC && (buf[1] & 0xe0) === 0xe0;
}

function matchesOgg(buf: Uint8Array): boolean {
  return startsWith(buf, OGG);
}

function matchesWav(buf: Uint8Array): boolean {
  // RIFF (0-3) + size (4-7) + "WAVE" (8-11).
  if (buf.length < 12) return false;
  for (let i = 0; i < RIFF.length; i++) {
    if (buf[i] !== RIFF[i]) return false;
  }
  for (let i = 0; i < WAVE.length; i++) {
    if (buf[8 + i] !== WAVE[i]) return false;
  }
  return true;
}

function matchesFlac(buf: Uint8Array): boolean {
  return startsWith(buf, FLAC);
}

function matchesZip(buf: Uint8Array): boolean {
  // ZIP local-file header "PK\x03\x04" or empty-archive "PK\x05\x06".
  // We only require the "PK" sentinel — jar/apk/office share it (caller
  // does extension cross-check separately for disguised executables).
  return startsWith(buf, PK_ZIP);
}

/**
 * Returns true when `head` (the object's prefix — ≥16 bytes for legacy
 * image checks, up to 8192 bytes on the S54 complete path) matches the
 * magic sequence for the declared mime. Unknown mimes return false —
 * the caller should whitelist accepted mimes BEFORE calling this helper,
 * not rely on an "unknown = allow" default.
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
    case 'application/pdf':
      return matchesPdf(head);
    case 'video/mp4':
      return matchesMp4(head);
    case 'audio/mpeg':
      return matchesMpegAudio(head);
    case 'audio/ogg':
      return matchesOgg(head);
    case 'audio/wav':
      return matchesWav(head);
    case 'audio/flac':
      return matchesFlac(head);
    case 'application/zip':
      return matchesZip(head);
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

/**
 * S54 (FR-AM-06): true 면 이 MIME 은 magic-byte 시그니처를 가지므로 complete 경로에서
 * `matchesMagic` 으로 교차검증한다. webm/avif/ogg-video/text/office 등 시그니처가
 * 없거나(텍스트) 컨테이너 변형이 많아 신뢰 가능한 prefix 검사가 어려운 MIME 은
 * false 를 반환하고 검사를 건너뛴다(declared MIME 화이트리스트는 이미 통과한 상태).
 */
const MAGIC_CHECKED_MIMES = new Set<MagicSupportedMime>([
  'image/png',
  'image/gif',
  'image/jpeg',
  'image/webp',
  'application/pdf',
  'video/mp4',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/flac',
  'application/zip',
]);

export function isMagicChecked(mime: string): mime is MagicSupportedMime {
  return MAGIC_CHECKED_MIMES.has(mime as MagicSupportedMime);
}

/** complete 경로에서 fetch 할 magic-byte prefix 크기(8192B = 8KiB). */
export const MAGIC_PREFIX_BYTES = 8192;
