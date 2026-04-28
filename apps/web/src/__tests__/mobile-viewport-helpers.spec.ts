import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

/**
 * task-040 R5 contract: ensure the mobile e2e helper exposes the
 * 414x896 (iPhone XR) viewport constant required by the task spec.
 *
 * This unit-level guard prevents the constant from being silently
 * removed from `apps/web/e2e/mobile/_helpers.ts`. The polish spec
 * `viewport-414-shell.polish.e2e.ts` imports the constant by name,
 * so a removal would fail e2e too — but those don't run on every
 * verify; this static check does.
 */

describe('mobile viewport helper contract (task-040 R5 + task-042 R5)', () => {
  it('_helpers.ts exposes MOBILE_VIEWPORT_XR = { width: 414, height: 896 }', () => {
    const root = execSync('git rev-parse --show-toplevel').toString().trim();
    const src = readFileSync(`${root}/apps/web/e2e/mobile/_helpers.ts`, 'utf8');
    const flat = src.replace(/\s+/g, ' ');
    expect(flat).toMatch(/MOBILE_VIEWPORT_XR\s*=\s*\{\s*width:\s*414,\s*height:\s*896\s*\}/);
    expect(flat).toContain('MOBILE_VIEWPORTS');
  });

  // task-042 R5 + reviewer M1: assert the new TABLET_VIEWPORT_PORTRAIT
  // and that MOBILE_VIEWPORTS array contains all four entries. The
  // 040-original spec passed for any non-empty array; reviewer flagged
  // this as illusory coverage. Strengthen here so a removal of either
  // const fails this static guard.
  it('_helpers.ts exposes TABLET_VIEWPORT_PORTRAIT = { width: 768, height: 1024 }', () => {
    const root = execSync('git rev-parse --show-toplevel').toString().trim();
    const src = readFileSync(`${root}/apps/web/e2e/mobile/_helpers.ts`, 'utf8');
    const flat = src.replace(/\s+/g, ' ');
    expect(flat).toMatch(/TABLET_VIEWPORT_PORTRAIT\s*=\s*\{\s*width:\s*768,\s*height:\s*1024\s*\}/);
  });

  it('MOBILE_VIEWPORTS array contains all four bands', () => {
    const root = execSync('git rev-parse --show-toplevel').toString().trim();
    const src = readFileSync(`${root}/apps/web/e2e/mobile/_helpers.ts`, 'utf8');
    const flat = src.replace(/\s+/g, ' ');
    // 4 named viewports must be referenced inside the MOBILE_VIEWPORTS
    // array initializer. The flat-whitespace flatten makes the regex
    // tolerant to indentation but strict on identifier list.
    expect(flat).toMatch(
      /MOBILE_VIEWPORTS\s*=\s*\[\s*MOBILE_VIEWPORT,\s*MOBILE_VIEWPORT_PRO,\s*MOBILE_VIEWPORT_XR,\s*TABLET_VIEWPORT_PORTRAIT,?\s*\]/,
    );
  });
});
