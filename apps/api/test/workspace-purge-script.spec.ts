import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * S72 fix-forward — scripts/workers/workspace-purge.sh structural invariants.
 *
 * purge.sh is a bash worker (cron inside qufox-backup) so we can't drive its
 * SQL through Prisma here. We instead pin the *correctness-critical structure*
 * the reviewers flagged, plus exercise the env-validation guards by actually
 * running the script. These guard against silent regressions of:
 *   - H2: restore↔purge race — anonymize + DELETE must be gated by a single
 *     row-locked eligibility re-check, and a non-eligible row must ROLLBACK.
 *   - M3: the dead SavedMessage.messageDeletedAt marking step must stay removed
 *     (SavedMessage.message is onDelete:Cascade — the Message CASCADE deletes it).
 *   - security MEDIUM: ANON_AUTHOR_UUID / WORKSPACE_PURGE_ANON_BATCH validation
 *     shuts the env→SQL injection surface (verified by running the script).
 *   - security MEDIUM: the SYSTEM_ANON insert is unique-conflict safe on BOTH
 *     id and the reserved 'deleted-user' username.
 *   - #5: the seeded passwordHash is the non-argon2 sentinel (no plaintext maps).
 */
const SCRIPT = resolve(__dirname, '../../../scripts/workers/workspace-purge.sh');
const SRC = readFileSync(SCRIPT, 'utf8');

describe('workspace-purge.sh — H2 restore↔purge eligibility gate', () => {
  it('locks the target row with FOR UPDATE and re-checks eligibility inside the tx', () => {
    expect(SRC).toContain('FOR UPDATE');
    // The eligibility predicate (soft-deleted AND past grace) gates anonymize+DELETE.
    expect(SRC).toMatch(/"deletedAt" IS NOT NULL\s*\n?\s*AND "deleteAt" < NOW\(\)/);
    // Conditional execution: eligible → anonymize+DELETE+COMMIT, else ROLLBACK.
    expect(SRC).toContain('\\if :eligible');
    expect(SRC).toContain('ROLLBACK;');
    expect(SRC).toContain('\\endif');
  });

  it('aborts on any SQL error so a half-applied tx cannot COMMIT', () => {
    expect(SRC).toContain('ON_ERROR_STOP=1');
  });
});

describe('workspace-purge.sh — M3 dead-write removal', () => {
  it('no longer marks SavedMessage.messageDeletedAt (Message CASCADE deletes those rows)', () => {
    expect(SRC).not.toContain('"messageDeletedAt"');
  });
});

describe('workspace-purge.sh — security MEDIUM unique-safe SYSTEM_ANON insert', () => {
  it('guards both the id and the reserved username against unique conflicts', () => {
    // INSERT ... SELECT ... WHERE NOT EXISTS (id OR username) — not a bare ON CONFLICT (id).
    expect(SRC).toMatch(/WHERE NOT EXISTS[\s\S]*username = 'deleted-user'/);
  });

  it('seeds the non-argon2 sentinel passwordHash (login is structurally impossible)', () => {
    expect(SRC).toContain("'x-no-login-$ANON_UUID'");
  });
});

describe('workspace-purge.sh — security MEDIUM env validation (executed)', () => {
  const run = (env: Record<string, string>): { code: number; out: string } => {
    try {
      const out = execFileSync('bash', [SCRIPT, '--dry-run'], {
        env: { ...process.env, ...env },
        encoding: 'utf8',
      });
      return { code: 0, out };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  };

  it('rejects an ANON_AUTHOR_UUID carrying a SQL-injection payload (exit 1)', () => {
    const { code, out } = run({
      DATABASE_URL: 'postgresql://x/y',
      ANON_AUTHOR_UUID: "'; DROP TABLE x; --",
    });
    expect(code).toBe(1);
    expect(out).toContain('not a valid UUID');
  });

  it('rejects a non-integer WORKSPACE_PURGE_ANON_BATCH (exit 1)', () => {
    const { code, out } = run({
      DATABASE_URL: 'postgresql://x/y',
      WORKSPACE_PURGE_ANON_BATCH: '5; DROP',
    });
    expect(code).toBe(1);
    expect(out).toContain('positive integer');
  });

  it('accepts a canonical UUID + integer batch (no FATAL validation error)', () => {
    // A valid UUID + integer must NOT trip either FATAL guard. We point at an
    // unreachable DB so the script proceeds past validation and only fails later
    // at the candidate query (psql cannot connect) — never with a FATAL: line.
    const { out } = run({
      DATABASE_URL: 'postgresql://127.0.0.1:1/nonexistent',
      ANON_AUTHOR_UUID: '871aa8f6-f28a-5e26-ba8f-37ca7126e9e3',
      WORKSPACE_PURGE_ANON_BATCH: '1000',
    });
    expect(out).not.toContain('FATAL: ANON_AUTHOR_UUID');
    expect(out).not.toContain('FATAL: WORKSPACE_PURGE_ANON_BATCH');
  });
});
