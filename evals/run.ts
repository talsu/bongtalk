/**
 * qufox eval harness (skeleton).
 *
 * Modes:
 *   --dry-run   : parse every yaml in evals/tasks/, validate schema,
 *                 write evals/report.md + evals/report.json summarizing.
 *                 Does not invoke any Claude Code headless run.
 *   (default)   : TODO(task-010) — invoke Claude Code headless per task,
 *                 score DoD, aggregate success rate.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

type DodCheck = { command: string; expect: string } | { scope_allow: string[] };

type EvalTask = {
  id: string;
  title: string;
  goal: string;
  dod: DodCheck[];
  max_turns: number;
};

type TaskResult = {
  id: string;
  title: string;
  status: 'pass' | 'fail' | 'skipped';
  reason?: string;
};

function parseYaml(text: string): EvalTask {
  // tiny yaml reader — accepts the narrow subset we use. No deps.
  const out: Record<string, unknown> = {};
  const lines = text.split(/\r?\n/);
  const dod: DodCheck[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line || line.trim().startsWith('#')) {
      i++;
      continue;
    }
    if (/^id:/.test(line)) out.id = String(line.split(':')[1]).trim();
    else if (/^title:/.test(line)) out.title = line.slice(6).trim();
    else if (/^max_turns:/.test(line)) out.max_turns = Number(line.split(':')[1]);
    else if (/^goal: \|/.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && (lines[i].startsWith('  ') || lines[i] === '')) {
        buf.push(lines[i].replace(/^  /, ''));
        i++;
      }
      out.goal = buf.join('\n').trim();
      continue;
    } else if (/^dod:/.test(line)) {
      i++;
      while (i < lines.length && /^\s*- /.test(lines[i])) {
        const entry: Record<string, unknown> = {};
        const allowGlobs: string[] = [];
        // consume entry lines
        while (i < lines.length && (lines[i].startsWith('    ') || /^\s*- /.test(lines[i]))) {
          const l = lines[i];
          if (/^\s*- command:/.test(l)) entry.command = l.split('command:')[1].trim();
          else if (/^\s*expect:/.test(l)) entry.expect = l.split('expect:')[1].trim();
          else if (/^\s*- scope_allow:/.test(l)) entry.kind = 'scope';
          else if (/^\s*-\s+".+"|^\s+-\s+.+/.test(l)) {
            const g = l
              .replace(/^\s*-\s+/, '')
              .replace(/^"(.*)"$/, '$1')
              .trim();
            if (g) allowGlobs.push(g);
          }
          i++;
          if (i < lines.length && /^[a-z_]+:/.test(lines[i])) break;
        }
        if (entry.kind === 'scope') dod.push({ scope_allow: allowGlobs });
        else if (entry.command && entry.expect)
          dod.push({ command: String(entry.command), expect: String(entry.expect) });
      }
      continue;
    }
    i++;
  }
  out.dod = dod;
  return out as EvalTask;
}

function loadTasks(dir: string): EvalTask[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort()
    .map((f) => parseYaml(readFileSync(join(dir, f), 'utf8')));
}

function validate(task: EvalTask): string | null {
  if (!task.id) return 'missing id';
  if (!task.title) return 'missing title';
  if (!task.goal) return 'missing goal';
  if (!Array.isArray(task.dod) || task.dod.length === 0) return 'empty dod';
  if (!task.max_turns || task.max_turns <= 0) return 'invalid max_turns';
  return null;
}

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');

const root = join(process.cwd(), 'evals');
const tasks = loadTasks(join(root, 'tasks'));
const results: TaskResult[] = [];

for (const t of tasks) {
  const err = validate(t);
  if (err) {
    results.push({ id: t.id ?? '?', title: t.title ?? '?', status: 'fail', reason: err });
    continue;
  }
  if (dryRun) {
    results.push({ id: t.id, title: t.title, status: 'skipped', reason: 'dry-run' });
    continue;
  }
  // TODO(task-010): spawn Claude Code headless, run DoD checks, record outcome.
  results.push({
    id: t.id,
    title: t.title,
    status: 'skipped',
    reason: 'headless runner not implemented yet',
  });
}

const passed = results.filter((r) => r.status === 'pass').length;
const effective = results.filter((r) => r.status !== 'skipped');
const successRate = effective.length > 0 ? passed / effective.length : 1;

const report = {
  generatedAt: new Date().toISOString(),
  dryRun,
  total: tasks.length,
  passed,
  skipped: results.filter((r) => r.status === 'skipped').length,
  failed: results.filter((r) => r.status === 'fail').length,
  successRate,
  results,
};
writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2));

const md = [
  `# eval report`,
  '',
  `- generated: ${report.generatedAt}`,
  `- mode: ${dryRun ? 'dry-run' : 'headless'}`,
  `- total: ${report.total}`,
  `- passed: ${report.passed}`,
  `- skipped: ${report.skipped}`,
  `- failed: ${report.failed}`,
  `- success rate: ${(successRate * 100).toFixed(1)}%`,
  '',
  `| id | title | status | reason |`,
  `|----|-------|--------|--------|`,
  ...results.map((r) => `| ${r.id} | ${r.title} | ${r.status} | ${r.reason ?? ''} |`),
  '',
].join('\n');
writeFileSync(join(root, 'report.md'), md);

console.log(
  `[eval] ${dryRun ? 'dry-run' : 'run'}: ${report.total} tasks, success=${(successRate * 100).toFixed(1)}%`,
);

if (!dryRun && successRate < 0.9) {
  process.exit(1);
}
