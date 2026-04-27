import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

// task-040 R2 + task-041 C-1/C-2 (review M4 follow): static guard
// preventing regression of <input> aria-label fixes across the entire
// apps/web/src tree (not just channel/DM critical path). axe-core
// flags an unlabeled form input as a serious-level `label` violation.
//
// 040 R2 covered 9 channel/DM inputs and ALLOWLISTED 6 surfaces as
// "out of scope". 041 C sweep removed all 6 from the ALLOWLIST after
// either adding aria-label or relying on a wrapping <label>:
//
//   - WorkspaceSettings (visibility radios → wrapped <label>; category
//     input → htmlFor)
//   - NotificationSettings (radios → aria-label + wrapped <label>)
//   - FriendsPage / MobileFriends (username input → aria-label)
//   - WorkspaceEmojiManager (file → aria-label; name → wrapped qf-field)
//   - ThreadPanel (disabled checkbox → wrapped <label>)
//
// The DS Input primitive stays allowlisted: it accepts aria-label as a
// prop and forwards it to the underlying <input>. The guard sees the
// internal <input ref={ref} ...> and would false-positive without the
// allowlist entry.

const ALLOWLIST = new Set([
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
      // task-041 C-1: surrounding <label> wrapper detection. Walk
      // up to 1500 chars of preceding source — long enough to cover
      // a sibling-radio fieldset (WorkspaceSettings PRIVATE/PUBLIC
      // radios put the second input ~480 chars after the first
      // <label>). If labelOpen > labelClose, the input sits inside
      // an open label.
      const before = src.slice(Math.max(0, m.index - 1500), m.index);
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
