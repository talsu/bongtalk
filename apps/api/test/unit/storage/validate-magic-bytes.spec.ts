import { describe, expect, it } from 'vitest';
import { matchesMagic } from '../../../src/storage/validate-magic-bytes';

const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const GIF87A = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0x00, 0x00]);
const GIF89A = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x00]);
const JPEG_HEADER = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const TEXT = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]); // "hello"

describe('matchesMagic', () => {
  it('accepts valid PNG header', () => {
    expect(matchesMagic(PNG_HEADER, 'image/png')).toBe(true);
  });

  it('accepts GIF87a and GIF89a', () => {
    expect(matchesMagic(GIF87A, 'image/gif')).toBe(true);
    expect(matchesMagic(GIF89A, 'image/gif')).toBe(true);
  });

  it('accepts JPEG SOI + JFIF marker', () => {
    expect(matchesMagic(JPEG_HEADER, 'image/jpeg')).toBe(true);
  });

  it('rejects PNG bytes declared as GIF', () => {
    expect(matchesMagic(PNG_HEADER, 'image/gif')).toBe(false);
  });

  it('rejects JPEG bytes declared as PNG', () => {
    expect(matchesMagic(JPEG_HEADER, 'image/png')).toBe(false);
  });

  it('rejects plain text declared as PNG/GIF/JPEG', () => {
    expect(matchesMagic(TEXT, 'image/png')).toBe(false);
    expect(matchesMagic(TEXT, 'image/gif')).toBe(false);
    expect(matchesMagic(TEXT, 'image/jpeg')).toBe(false);
  });

  it('rejects truncated headers', () => {
    expect(matchesMagic(new Uint8Array([0x89, 0x50]), 'image/png')).toBe(false);
    expect(matchesMagic(new Uint8Array([0x47, 0x49]), 'image/gif')).toBe(false);
  });

  it('rejects GIF with invalid variant byte', () => {
    const invalid = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x35, 0x61]); // GIF85a
    expect(matchesMagic(invalid, 'image/gif')).toBe(false);
  });
});
