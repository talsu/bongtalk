export interface DeployJob {
  sha: string;
  branch: string;
  pusher: string;
  enqueuedAt: number;
}

export type Outcome = 'ok' | 'failed';

export interface Runner {
  (job: DeployJob): Promise<Outcome>;
}

/**
 * Single-slot coalescing queue. One deploy runs at a time; while it is
 * running we keep at most ONE pending job (the latest push wins, older
 * pending jobs are dropped). GitHub fans out a webhook per push, so if
 * three commits land in quick succession we run the first + the last,
 * which is the desired semantic: we never skip the tip of the branch,
 * but we don't build every intermediate SHA either.
 */
export class DeployQueue {
  private active: DeployJob | null = null;
  private pending: DeployJob | null = null;
  private readonly listeners = new Set<(j: DeployJob, o: Outcome) => void>();

  constructor(private readonly runner: Runner) {}

  onSettled(fn: (job: DeployJob, outcome: Outcome) => void): void {
    this.listeners.add(fn);
  }

  state(): { active: DeployJob | null; pending: DeployJob | null } {
    return { active: this.active, pending: this.pending };
  }

  submit(job: DeployJob): 'started' | 'queued' | 'coalesced' {
    if (this.active === null) {
      this.active = job;
      // Fire-and-forget: errors inside run() are caught and logged via runner.
      void this.run();
      return 'started';
    }
    const hadPending = this.pending !== null;
    this.pending = job;
    return hadPending ? 'coalesced' : 'queued';
  }

  private async run(): Promise<void> {
    while (this.active !== null) {
      const current = this.active;
      let outcome: Outcome = 'failed';
      try {
        outcome = await this.runner(current);
      } catch {
        outcome = 'failed';
      }
      for (const fn of this.listeners) {
        try {
          fn(current, outcome);
        } catch {
          /* listener errors never break the queue */
        }
      }
      this.active = this.pending;
      this.pending = null;
    }
  }
}
