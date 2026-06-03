import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  UPLOAD_TTL_DEFAULT_SEC,
  UPLOAD_TTL_MEDIUM_SEC,
  UPLOAD_TTL_LARGE_SEC,
} from '@qufox/shared-types';
import {
  extractExtension,
  isBlockedExtension,
  isZipExtensionMismatch,
  kindForMime,
  ttlForSize,
} from './attachment-validation';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('S54 attachment-validation — extractExtension (FR-AM-05)', () => {
  it('extracts the lowercased extension after the last dot', () => {
    expect(extractExtension('photo.JPG')).toBe('jpg');
    expect(extractExtension('archive.tar.gz')).toBe('gz');
    expect(extractExtension('report.PDF')).toBe('pdf');
  });

  it('returns null when there is no usable extension', () => {
    expect(extractExtension('noext')).toBeNull();
    expect(extractExtension('trailingdot.')).toBeNull();
    expect(extractExtension('.hiddenonly')).toBeNull();
  });

  it('rejects extensions with disallowed chars (path/null-byte tricks)', () => {
    expect(extractExtension('evil.ph p')).toBeNull();
    expect(extractExtension('x.<<<')).toBeNull();
    // too long (>20)
    expect(extractExtension('x.' + 'a'.repeat(21))).toBeNull();
  });
});

describe('S54 attachment-validation — isBlockedExtension (FR-AM-05)', () => {
  it.each(['exe', 'dll', 'bat', 'com', 'msi', 'vbs', 'ps1', 'jar', 'apk', 'scr', 'pif', 'iso'])(
    'blocks .%s',
    (ext) => {
      expect(isBlockedExtension(ext)).toBe(true);
    },
  );

  it('allows benign extensions', () => {
    expect(isBlockedExtension('png')).toBe(false);
    expect(isBlockedExtension('pdf')).toBe(false);
    expect(isBlockedExtension('zip')).toBe(false);
    expect(isBlockedExtension(null)).toBe(false);
  });
});

describe('S54 attachment-validation — isZipExtensionMismatch (FR-AM-05 cross-check)', () => {
  it('rejects application/zip declared with executable-archive extensions', () => {
    expect(isZipExtensionMismatch('application/zip', 'jar')).toBe(true);
    expect(isZipExtensionMismatch('application/zip', 'apk')).toBe(true);
    expect(isZipExtensionMismatch('application/zip', 'ipa')).toBe(true);
    // case-insensitive mime
    expect(isZipExtensionMismatch('APPLICATION/ZIP', 'jar')).toBe(true);
  });

  it('allows application/zip with a plain zip extension', () => {
    expect(isZipExtensionMismatch('application/zip', 'zip')).toBe(false);
  });

  it('is a no-op for non-zip mimes', () => {
    expect(isZipExtensionMismatch('image/png', 'jar')).toBe(false);
    expect(isZipExtensionMismatch('application/zip', null)).toBe(false);
  });
});

describe('S54 attachment-validation — kindForMime (FR-AM-06 whitelist)', () => {
  it('maps allowed image/video/file mimes', () => {
    expect(kindForMime('image/png')).toBe('IMAGE');
    expect(kindForMime('image/avif')).toBe('IMAGE');
    expect(kindForMime('video/mp4')).toBe('VIDEO');
    expect(kindForMime('audio/mpeg')).toBe('FILE');
    expect(kindForMime('application/pdf')).toBe('FILE');
    expect(kindForMime('application/zip')).toBe('FILE');
    expect(
      kindForMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    ).toBe('FILE');
  });

  it('rejects SVG (XSS risk — blocked by default) and unknown mimes', () => {
    expect(kindForMime('image/svg+xml')).toBeNull();
    expect(kindForMime('application/x-msdownload')).toBeNull();
    expect(kindForMime('text/html')).toBeNull();
  });
});

describe('S54 attachment-validation — ttlForSize (FR-AM-03 size branch)', () => {
  it('default TTL under 30MB', () => {
    expect(ttlForSize(1)).toBe(UPLOAD_TTL_DEFAULT_SEC);
    expect(ttlForSize(29 * 1024 * 1024)).toBe(UPLOAD_TTL_DEFAULT_SEC);
  });

  it('medium TTL from 30MB to under 80MB', () => {
    expect(ttlForSize(30 * 1024 * 1024)).toBe(UPLOAD_TTL_MEDIUM_SEC);
    expect(ttlForSize(79 * 1024 * 1024)).toBe(UPLOAD_TTL_MEDIUM_SEC);
  });

  it('large TTL from 80MB up', () => {
    expect(ttlForSize(80 * 1024 * 1024)).toBe(UPLOAD_TTL_LARGE_SEC);
    expect(ttlForSize(100 * 1024 * 1024)).toBe(UPLOAD_TTL_LARGE_SEC);
  });
});
