/**
 * pnpm debug:dump — snapshots recent logs, db table counts, redis summary
 * into ./.debug/latest.json for AI/human inspection.
 *
 * Safe to run without db/redis available — each probe is best-effort.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

type Dump = {
  generatedAt: string;
  env: {
    node: string;
    platform: string;
    cwd: string;
  };
  git: { head: string | null; dirty: boolean };
  logs: string[];
  db: { reachable: boolean; note: string; counts?: Record<string, number> };
  redis: { reachable: boolean; note: string; keys?: string[]; info?: string };
};

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function lastLines(text: string, n: number): string[] {
  return text.trim().split(/\r?\n/).slice(-n);
}

const outDir = join(process.cwd(), '.debug');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, 'latest.json');

const dump: Dump = {
  generatedAt: new Date().toISOString(),
  env: {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    cwd: process.cwd(),
  },
  git: {
    head: safe(() => execSync('git rev-parse HEAD').toString().trim(), null),
    dirty: safe(() => execSync('git status --porcelain').toString().trim().length > 0, false),
  },
  logs: (() => {
    const logFile = join(process.cwd(), '.debug', 'api.log');
    if (existsSync(logFile)) {
      return lastLines(readFileSync(logFile, 'utf8'), 100);
    }
    return ['(no .debug/api.log present — run `pnpm dev` with log redirection to capture)'];
  })(),
  db: (() => {
    const url =
      process.env.DATABASE_URL ?? 'postgresql://qufox:qufox@localhost:5432/qufox?schema=public';
    const probe = safe(
      () => execSync(`docker-compose exec -T postgres pg_isready -U qufox`).toString(),
      '',
    );
    const reachable = probe.includes('accepting connections');
    if (!reachable) {
      return { reachable: false, note: `unreachable via docker-compose (url=${url})` };
    }
    const counts: Record<string, number> = {};
    for (const t of ['User', 'Workspace', 'WorkspaceMember', 'Channel', 'Message', 'Invite']) {
      counts[t] = safe(() => {
        const out = execSync(
          `docker-compose exec -T postgres psql -U qufox -d qufox -tA -c 'SELECT count(*) FROM "${t}";'`,
        ).toString();
        return Number(out.trim()) || 0;
      }, -1);
    }
    return { reachable: true, note: 'ok', counts };
  })(),
  redis: (() => {
    const reachable = safe(
      () => execSync('docker-compose exec -T redis redis-cli ping').toString().includes('PONG'),
      false,
    );
    if (!reachable) return { reachable: false, note: 'redis unreachable' };
    const keysRaw = safe(
      () => execSync('docker-compose exec -T redis redis-cli --scan --count 50').toString(),
      '',
    );
    const keys = keysRaw.trim().split(/\r?\n/).filter(Boolean).slice(0, 50);
    const info = safe(
      () => execSync('docker-compose exec -T redis redis-cli info server').toString(),
      '',
    );
    return { reachable: true, note: 'ok', keys, info: info.split(/\r?\n/).slice(0, 10).join('\n') };
  })(),
};

writeFileSync(outPath, JSON.stringify(dump, null, 2));
console.log(`[debug-dump] wrote ${outPath}`);
