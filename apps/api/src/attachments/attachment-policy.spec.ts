import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BLOCKED_EXTENSIONS } from '@qufox/shared-types';
import {
  effectiveMaxBytes,
  isBlockedByPolicy,
  mergedBlockedExtensions,
  requiresAttachmentDisposition,
} from './attachment-policy';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

const DEFAULT_MAX = 100 * 1024 * 1024;

describe('S55 attachment-policy — effectiveMaxBytes (FR-AM-20)', () => {
  it('uses the channel override when present (channel → ws → default)', () => {
    expect(
      effectiveMaxBytes({
        channelMaxBytes: BigInt(5 * 1024 * 1024),
        workspaceMaxBytes: BigInt(20 * 1024 * 1024),
        defaultMaxBytes: DEFAULT_MAX,
        workspaceBlockedExtensions: [],
      }),
    ).toBe(5 * 1024 * 1024);
  });

  it('falls back to the workspace value when channel is null', () => {
    expect(
      effectiveMaxBytes({
        channelMaxBytes: null,
        workspaceMaxBytes: BigInt(20 * 1024 * 1024),
        defaultMaxBytes: DEFAULT_MAX,
        workspaceBlockedExtensions: [],
      }),
    ).toBe(20 * 1024 * 1024);
  });

  it('falls back to the global default when both overrides are null', () => {
    expect(
      effectiveMaxBytes({
        channelMaxBytes: null,
        workspaceMaxBytes: null,
        defaultMaxBytes: DEFAULT_MAX,
        workspaceBlockedExtensions: [],
      }),
    ).toBe(DEFAULT_MAX);
  });

  it('caps an over-large override at the global hard limit', () => {
    expect(
      effectiveMaxBytes({
        channelMaxBytes: BigInt(500 * 1024 * 1024),
        workspaceMaxBytes: null,
        defaultMaxBytes: DEFAULT_MAX,
        workspaceBlockedExtensions: [],
      }),
    ).toBe(DEFAULT_MAX);
  });
});

describe('S55 attachment-policy — blocked extensions union (FR-AM-20)', () => {
  it('merges global BLOCKED_EXTENSIONS with the workspace list (deduped, lowercased)', () => {
    const merged = mergedBlockedExtensions(['ZIPX', 'exe']);
    expect(merged.has('exe')).toBe(true); // global + ws overlap deduped
    expect(merged.has('zipx')).toBe(true); // ws-only, lowercased
    // every global entry survives the union
    for (const e of BLOCKED_EXTENSIONS) expect(merged.has(e)).toBe(true);
  });

  it('isBlockedByPolicy blocks a workspace-only extension', () => {
    expect(isBlockedByPolicy('iso', ['iso'])).toBe(true);
    expect(isBlockedByPolicy('png', ['iso'])).toBe(false);
  });

  it('isBlockedByPolicy still blocks a global extension even with empty ws list', () => {
    expect(isBlockedByPolicy('exe', [])).toBe(true);
  });

  it('isBlockedByPolicy returns false for a null extension', () => {
    expect(isBlockedByPolicy(null, ['iso'])).toBe(false);
  });
});

describe('S55 attachment-policy — requiresAttachmentDisposition (FR-AM-17)', () => {
  it('forces attachment disposition for SVG (script embed risk)', () => {
    expect(requiresAttachmentDisposition('image/svg+xml')).toBe(true);
  });

  it('forces attachment disposition for HTML / XML / JS', () => {
    expect(requiresAttachmentDisposition('text/html')).toBe(true);
    expect(requiresAttachmentDisposition('application/xhtml+xml')).toBe(true);
    expect(requiresAttachmentDisposition('application/xml')).toBe(true);
    expect(requiresAttachmentDisposition('text/javascript')).toBe(true);
    expect(requiresAttachmentDisposition('application/javascript')).toBe(true);
  });

  it('allows inline for safe preview types (image / video / pdf)', () => {
    expect(requiresAttachmentDisposition('image/png')).toBe(false);
    expect(requiresAttachmentDisposition('image/jpeg')).toBe(false);
    expect(requiresAttachmentDisposition('video/mp4')).toBe(false);
    expect(requiresAttachmentDisposition('application/pdf')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(requiresAttachmentDisposition('IMAGE/SVG+XML')).toBe(true);
    expect(requiresAttachmentDisposition('IMAGE/PNG')).toBe(false);
  });
});
