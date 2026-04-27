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

describe('mobile viewport helper contract (task-040 R5)', () => {
  it('_helpers.ts exposes MOBILE_VIEWPORT_XR = { width: 414, height: 896 }', () => {
    const root = execSync('git rev-parse --show-toplevel').toString().trim();
    const src = readFileSync(`${root}/apps/web/e2e/mobile/_helpers.ts`, 'utf8');
    const flat = src.replace(/\s+/g, ' ');
    expect(flat).toMatch(/MOBILE_VIEWPORT_XR\s*=\s*\{\s*width:\s*414,\s*height:\s*896\s*\}/);
    expect(flat).toContain('MOBILE_VIEWPORTS');
  });
});
