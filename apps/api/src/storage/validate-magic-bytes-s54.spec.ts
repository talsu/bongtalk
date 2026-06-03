import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  matchesMagic,
  isMagicChecked,
  MAGIC_PREFIX_BYTES,
  type MagicSupportedMime,
} from './validate-magic-bytes';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

function bytes(...arr: number[]): Uint8Array {
  return new Uint8Array(arr);
}

describe('S54 validate-magic-bytes — new signatures (FR-AM-06)', () => {
  it('PDF: "%PDF-" header matches', () => {
    expect(matchesMagic(bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31), 'application/pdf')).toBe(true);
    expect(matchesMagic(bytes(0x68, 0x65, 0x6c, 0x6c, 0x6f), 'application/pdf')).toBe(false);
  });

  it('MP4: "ftyp" at bytes 4-7 matches regardless of leading box size', () => {
    expect(
      matchesMagic(bytes(0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70), 'video/mp4'),
    ).toBe(true);
    expect(matchesMagic(bytes(0x00, 0x00, 0x00, 0x18, 0x00, 0x00, 0x00, 0x00), 'video/mp4')).toBe(
      false,
    );
  });

  it('audio/mpeg: ID3 tag OR raw frame sync', () => {
    expect(matchesMagic(bytes(0x49, 0x44, 0x33, 0x04), 'audio/mpeg')).toBe(true); // "ID3"
    expect(matchesMagic(bytes(0xff, 0xfb, 0x90), 'audio/mpeg')).toBe(true); // frame sync
    expect(matchesMagic(bytes(0x00, 0x01), 'audio/mpeg')).toBe(false);
  });

  it('audio/ogg: "OggS"', () => {
    expect(matchesMagic(bytes(0x4f, 0x67, 0x67, 0x53), 'audio/ogg')).toBe(true);
    expect(matchesMagic(bytes(0x4f, 0x67, 0x67), 'audio/ogg')).toBe(false);
  });

  it('audio/wav: RIFF....WAVE', () => {
    expect(
      matchesMagic(
        bytes(0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45),
        'audio/wav',
      ),
    ).toBe(true);
    // RIFF but WEBP (not WAVE) must not match
    expect(
      matchesMagic(
        bytes(0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50),
        'audio/wav',
      ),
    ).toBe(false);
  });

  it('audio/flac: "fLaC"', () => {
    expect(matchesMagic(bytes(0x66, 0x4c, 0x61, 0x43, 0x00), 'audio/flac')).toBe(true);
    expect(matchesMagic(bytes(0x46, 0x4c, 0x41, 0x43), 'audio/flac')).toBe(false);
  });

  it('application/zip: "PK" sentinel', () => {
    expect(matchesMagic(bytes(0x50, 0x4b, 0x03, 0x04), 'application/zip')).toBe(true);
    expect(matchesMagic(bytes(0x50, 0x4b, 0x05, 0x06), 'application/zip')).toBe(true); // empty archive
    expect(matchesMagic(bytes(0x52, 0x61, 0x72), 'application/zip')).toBe(false); // RAR, not zip
  });

  it('still validates the original image signatures', () => {
    expect(matchesMagic(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), 'image/png')).toBe(
      true,
    );
    expect(matchesMagic(bytes(0xff, 0xd8, 0xff, 0xe0), 'image/jpeg')).toBe(true);
  });
});

describe('S54 validate-magic-bytes — isMagicChecked', () => {
  it('returns true for signature-bearing mimes', () => {
    const checked: MagicSupportedMime[] = [
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/webp',
      'application/pdf',
      'video/mp4',
      'audio/mpeg',
      'audio/ogg',
      'audio/wav',
      'audio/flac',
      'application/zip',
    ];
    for (const m of checked) expect(isMagicChecked(m)).toBe(true);
  });

  it('returns false for mimes without a reliable prefix check', () => {
    expect(isMagicChecked('video/webm')).toBe(false);
    expect(isMagicChecked('image/avif')).toBe(false);
    expect(isMagicChecked('text/plain')).toBe(false);
    expect(isMagicChecked('application/x-tar')).toBe(false);
  });

  it('exports an 8192-byte prefix window', () => {
    expect(MAGIC_PREFIX_BYTES).toBe(8192);
  });
});
