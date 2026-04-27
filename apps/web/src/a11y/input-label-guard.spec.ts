import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

// task-040 round 2 (a11y): static guard preventing regression of the
// 9 critical-path <input> aria-label fixes. axe-core flags an unlabeled
// form input as a serious-level `label` violation; the channel/DM
// surfaces (composer, search, edit, file-attach) MUST stay labelled.
//
// Allowlist holds inputs we deliberately leave for follow-up (out-of-
// scope: workspace settings, friends, notification settings, emoji
// manager, thread checkbox-disabled, internal DS primitive that
// forwards aria-label from props).

const ALLOWLIST = new Set([
  'apps/web/src/features/workspaces/WorkspaceSettingsPage.tsx',
  'apps/web/src/features/settings/NotificationSettingsPage.tsx',
  'apps/web/src/features/friends/FriendsPage.tsx',
  'apps/web/src/shell/mobile/MobileFriends.tsx',
  'apps/web/src/features/emojis/WorkspaceEmojiManager.tsx',
  'apps/web/src/features/threads/ThreadPanel.tsx',
  'apps/web/src/design-system/primitives/Input.tsx', // forwards from props
]);

function findRepoRoot(): string {
  return execSync('git rev-parse --show-toplevel').toString().trim();
}

function listSourceFiles(root: string): string[] {
  // recursive list via shell — globSync is node 22+, avoid for portability
  const out = execSync(`find ${root}/apps/web/src -name '*.tsx'`, {
    maxBuffer: 64 * 1024 * 1024,
  }).toString();
  return out.split('\n').filter(Boolean);
}

interface Finding {
  file: string;
  line: number;
  attrs: string;
}

function scan(files: string[], root: string): Finding[] {
  const out: Finding[] = [];
  for (const abs of files) {
    const rel = abs.replace(root + '/', '');
    if (ALLOWLIST.has(rel)) continue;
    const src = readFileSync(abs, 'utf8');
    const re = /<input\b([^>]*?)\/?>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const attrs = m[1];
      if (/type="hidden"/.test(attrs)) continue;
      if (/type="checkbox"/.test(attrs) && /disabled\b/.test(attrs)) continue;
      if (/aria-label\b/.test(attrs)) continue;
      if (/aria-labelledby\b/.test(attrs)) continue;
      // surrounding <label> wrapper (parent in same JSX)
      const before = src.slice(Math.max(0, m.index - 400), m.index);
      const labelOpen = (before.match(/<label\b/g) || []).length;
      const labelClose = (before.match(/<\/label>/g) || []).length;
      if (labelOpen > labelClose) continue;
      // htmlFor association (case-insensitive id lookup)
      const idMatch = /\bid="([^"]+)"/.exec(attrs);
      if (idMatch) {
        const target = idMatch[1];
        if (src.includes(`htmlFor="${target}"`)) continue;
        if (src.includes(`htmlFor={'${target}'}`)) continue;
      }
      const line = src.slice(0, m.index).split('\n').length;
      out.push({ file: rel, line, attrs: attrs.trim().slice(0, 100) });
    }
  }
  return out;
}

describe('a11y: input label coverage (task-040 R2)', () => {
  it('no critical-path <input> on apps/web/src is missing aria-label / wrapping <label> / htmlFor', () => {
    const root = findRepoRoot();
    const files = listSourceFiles(root);
    const findings = scan(files, root);
    expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
  });
});
