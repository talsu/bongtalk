import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface AuditEvent {
  ts: string;
  event: string;
  [key: string]: unknown;
}

export class AuditLog {
  private readyPromise: Promise<void> | null = null;

  constructor(private readonly path: string) {}

  private ensureDir(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = mkdir(dirname(this.path), { recursive: true }).then(() => undefined);
    }
    return this.readyPromise;
  }

  async append(event: string, payload: Record<string, unknown> = {}): Promise<void> {
    const line: AuditEvent = { ts: new Date().toISOString(), event, ...payload };
    try {
      await this.ensureDir();
      await appendFile(this.path, JSON.stringify(line) + '\n', 'utf8');
    } catch (err) {
      // Never let the audit writer break the webhook. stderr so ops can
      // notice; structured logging is a later concern.
      process.stderr.write(
        `[webhook.audit] append failed: ${(err as Error).message ?? String(err)}\n`,
      );
    }
  }
}
