import { appendFile, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface AuditEvent {
  ts: string;
  event: string;
  [key: string]: unknown;
}

export interface AuditOptions {
  /** Bytes after which the file is rotated. Default 5 MB. */
  maxBytes?: number;
  /** How many rotated files to keep. Default 5 (audit.jsonl.1 .. .5). */
  maxFiles?: number;
}

/**
 * Append-only JSONL audit writer with size-based rotation.
 *
 * Task-011-C MED-1 fix — the task-009 reviewer flagged this as
 * unbounded. On every append we check the current file size; if it
 * exceeds `maxBytes`, rename
 *   audit.jsonl.(N-1) → audit.jsonl.N
 *   …
 *   audit.jsonl.1 → audit.jsonl.2
 *   audit.jsonl   → audit.jsonl.1
 * and keep appending to a fresh audit.jsonl. The oldest file
 * (.maxFiles) is removed.
 *
 * Rotation runs in-process (no external logrotate dep) and is
 * serialised by a simple promise-chain so concurrent appends can't
 * race the rename. Errors during rotation fall through to stderr —
 * the audit write is best-effort and MUST NOT block the webhook.
 */
export class AuditLog {
  private readyPromise: Promise<void> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private readonly maxBytes: number;
  private readonly maxFiles: number;

  constructor(
    private readonly path: string,
    opts: AuditOptions = {},
  ) {
    this.maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
    this.maxFiles = opts.maxFiles ?? 5;
  }

  private ensureDir(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = mkdir(dirname(this.path), { recursive: true }).then(() => undefined);
    }
    return this.readyPromise;
  }

  async append(event: string, payload: Record<string, unknown> = {}): Promise<void> {
    const line: AuditEvent = { ts: new Date().toISOString(), event, ...payload };
    const serialized = JSON.stringify(line) + '\n';
    // Serialise via the chain so rotation + append are ordered under
    // concurrent calls. Each link resolves regardless of outcome so a
    // single failed append can't wedge future ones.
    const next = this.chain.then(async () => {
      try {
        await this.ensureDir();
        await this.rotateIfNeeded(Buffer.byteLength(serialized, 'utf8'));
        await appendFile(this.path, serialized, 'utf8');
      } catch (err) {
        process.stderr.write(
          `[webhook.audit] append failed: ${(err as Error).message ?? String(err)}\n`,
        );
      }
    });
    this.chain = next;
    return next;
  }

  /**
   * If writing `incomingBytes` more would take `audit.jsonl` past the
   * size threshold, shuffle the numbered files down one slot and drop
   * the oldest. Called inside the append chain so the rename is not
   * interleaved with a concurrent append.
   */
  private async rotateIfNeeded(incomingBytes: number): Promise<void> {
    let currentSize: number;
    try {
      currentSize = (await stat(this.path)).size;
    } catch {
      // File doesn't exist yet — nothing to rotate.
      return;
    }
    if (currentSize + incomingBytes <= this.maxBytes) return;

    // Drop the oldest (maxFiles-th) rotated file if present. We use
    // `unlink` rather than `rm -f` semantics: missing file is fine.
    try {
      await unlink(`${this.path}.${this.maxFiles}`);
    } catch {
      /* not present, ignore */
    }
    // Shift .(N-1) → .N for each slot in descending order.
    for (let n = this.maxFiles - 1; n >= 1; n--) {
      const from = `${this.path}.${n}`;
      const to = `${this.path}.${n + 1}`;
      try {
        await rename(from, to);
      } catch {
        /* slot not present, ignore */
      }
    }
    // Move the current file into slot 1. A subsequent append will
    // create a fresh audit.jsonl.
    await rename(this.path, `${this.path}.1`);
  }
}
