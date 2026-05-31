import { GAP_FETCH_CONCURRENCY } from '@qufox/shared-types';

/**
 * S10 (FR-RT-23): gap-fetch 동시성 상한 FIFO 큐 — 순수 로직.
 *
 * 재연결 후 여러 채널이 동시에 GAP_FETCHING 에 진입하면 REST 가 폭주합니다.
 * 동시에 실제 실행되는 작업 수를 GAP_FETCH_CONCURRENCY(기본 5, env override)로
 * 제한하고, 초과 작업은 FIFO 큐에서 대기하다 슬롯이 비면 진입 순서대로 실행합니다.
 *
 * 같은 channelId 에 대한 중복 enqueue 는 무시합니다(동일 채널이 fetch 중이거나
 * 대기 중이면 두 번째 요청은 기존 작업의 promise 를 공유). React 의존이 없어
 * 훅과 단위 테스트가 공유합니다.
 */

type Task = {
  channelId: string;
  run: () => Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
};

export function resolveGapFetchConcurrency(): number {
  const raw = import.meta.env?.VITE_GAP_FETCH_CONCURRENCY as string | undefined;
  const n = raw === undefined || raw === '' ? NaN : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return GAP_FETCH_CONCURRENCY;
  return Math.floor(n);
}

export class GapFetchQueue {
  private readonly queue: Task[] = [];
  private readonly active = new Set<string>();
  /** channelId → 진행/대기 중 작업의 완료 promise(중복 enqueue 공유용). */
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(private readonly concurrency = resolveGapFetchConcurrency()) {}

  /**
   * 채널의 gap-fetch 작업을 enqueue 합니다. 동시 실행 슬롯이 남으면 즉시
   * 실행, 아니면 FIFO 대기. 같은 channelId 가 이미 진행/대기 중이면 그
   * 작업의 promise 를 반환(중복 실행 방지).
   */
  enqueue(channelId: string, run: () => Promise<void>): Promise<void> {
    const existing = this.inflight.get(channelId);
    if (existing) return existing;

    const promise = new Promise<void>((resolve, reject) => {
      this.queue.push({ channelId, run, resolve, reject });
      this.pump();
    });
    this.inflight.set(channelId, promise);
    // 완료/실패 무관하게 inflight 추적에서 제거. `.finally` 의 반환 promise 가
    // 원본 reject 를 전파해 unhandled rejection 이 되지 않도록 별도 핸들러로
    // 흡수합니다(원본 promise 의 reject 는 호출자가 받습니다).
    promise.then(
      () => this.inflight.delete(channelId),
      () => this.inflight.delete(channelId),
    );
    return promise;
  }

  /** 현재 동시 실행 중인 작업 수. */
  get activeCount(): number {
    return this.active.size;
  }

  /** 대기 중(미실행) 작업 수. */
  get pendingCount(): number {
    return this.queue.length;
  }

  private pump(): void {
    while (this.active.size < this.concurrency && this.queue.length > 0) {
      const task = this.queue.shift()!;
      this.active.add(task.channelId);
      // run 을 마이크로태스크 경계에서 시작 — 예외도 promise 로 흡수.
      void Promise.resolve()
        .then(() => task.run())
        .then(
          () => {
            this.active.delete(task.channelId);
            task.resolve();
            this.pump();
          },
          (err) => {
            this.active.delete(task.channelId);
            task.reject(err);
            this.pump();
          },
        );
    }
  }
}
