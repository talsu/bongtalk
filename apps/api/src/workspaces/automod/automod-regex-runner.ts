import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Worker } from 'node:worker_threads';
import type { AutoModRegexWorkerRequest, AutoModRegexWorkerResponse } from './automod-regex.worker';

/**
 * FR-RM10b: worker 엔트리의 인라인 JS 소스(eval worker).
 *
 * ★빌드/resolve 결정: worker 파일을 .ts/.js 경로로 resolve 하면 prod(dist .js)는 되지만
 * vitest/개발(.ts)에서는 Node 가 .ts 를 raw worker 로 못 읽어 spawn 이 실패한다(loader 의존).
 * 환경마다 동작이 갈리는 fragile 함을 없애기 위해 worker 로직을 ★순수 JS 문자열로 인라인하고
 * `new Worker(src, { eval: true })` 로 띄운다 — prod/dev/vitest/int 가 동일하게 동작하며 별도
 * 빌드 자산·loader·경로 resolve 가 전혀 필요 없다. 로직은 정규식 컴파일 + test() 뿐이라 인라인
 * 으로 충분하다(automod-regex.worker.ts 는 동일 로직의 타입·문서 정본이며 직접 로드되지 않는다).
 */
const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
function handleMatch(sources, content) {
  for (const src of sources) {
    let re;
    try { re = new RegExp(src); } catch (e) { continue; }
    if (re.test(content)) return src;
  }
  return null;
}
function handleValidate(source, probe) {
  let re;
  try { re = new RegExp(source); } catch (e) { return false; }
  re.test(probe);
  return true;
}
if (parentPort) {
  parentPort.on('message', (msg) => {
    if (msg.kind === 'match') {
      parentPort.postMessage({ kind: 'match', id: msg.id, matched: handleMatch(msg.sources, msg.content) });
      return;
    }
    parentPort.postMessage({ kind: 'validate', id: msg.id, ok: handleValidate(msg.source, msg.probe) });
  });
}
`;

/**
 * FR-RM10b (069 / ADR E1): AutoMod 정규식 매칭/검증의 worker_threads 격리 실행자.
 *
 * 책임:
 *   1) match(sources, content)   — send/edit hot-path. 단일 패턴 매칭 ≤10ms 워치독.
 *      초과 시 worker.terminate() + respawn + AUTOMOD_TIMEOUT 신호({matched:null,timedOut:true}).
 *      worker 비정상 종료/resolve 실패 → fail-open(매칭 없음 · 메시지 통과 · send 영향 0).
 *   2) validateSafety(source)    — 룰 저장 시 ReDoS 검증. 병리적 입력에 100ms 워치독 매칭.
 *      초과/컴파일 실패 → unsafe(false). CRUD 가 REGEX_UNSAFE(400) 로 변환한다.
 *
 * worker resolve: ★인라인 eval worker(WORKER_SOURCE)를 `new Worker(src,{eval:true})` 로 띄운다
 * — 경로 resolve·빌드 자산·loader 가 전혀 필요 없어 prod/dev/vitest/int 가 동일하게 동작한다.
 * worker_threads 자체가 불가한(극히 드문) 환경에서 spawn 이 실패하면 ★fail-open(매칭 격리는
 * best-effort — 모더레이션은 통과 우선)한다. 단위 테스트는 validateRegexSafetyInline(순수 함수)
 * 으로 워치독 로직을 직접 검증한다(worker 불요).
 */
@Injectable()
export class AutoModRegexRunner implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AutoModRegexRunner.name);

  /**
   * 매칭 워치독(ms) — 단일 패턴(전체 sources 일괄) 매칭 상한. ★worker 는 onModuleInit 에서
   * warm-up 으로 미리 spawn 하므로(cold start 비용 제거) 정상 정규식 매칭은 sub-ms 다. 워치독은
   * catastrophic backtracking 만 잡으면 되므로 10ms 면 충분하다.
   */
  static readonly MATCH_WATCHDOG_MS = 10;
  /** 검증 워치독(ms) — 저장 시 병리적 입력 매칭 상한. */
  static readonly VALIDATE_WATCHDOG_MS = 100;
  /**
   * ReDoS 검증용 병리적 probe 입력 세트(catastrophic backtracking 유발).
   *
   * ★HIGH (069 fix-forward · false-negative 차단): 종전 단일 probe('a'×28+'!')는 'a' 반복에만
   * 좀비를 유발해, 비-'a' 클래스로 폭발하는 catastrophic 패턴(`(b+)+$`·`(\d+)+$`·`(\s+)*$` 등)이
   * probe 에서 0ms(통과)로 저장된 뒤 실제 악성 입력에서 hot-path fail-open 으로 룰을 무력화했다.
   * 다양한 문자클래스(영문 소/대문자·숫자·구분자·공백)를 섞은 ★복수 probe 를 순차 검증해, 그중
   * 하나라도 워치독을 초과하면 unsafe 로 본다. 단일문자 반복(같은 클래스 연속)도 각 probe 안에
   * 충분히 들어 있어 `(a+)+$` 류도 그대로 잡힌다.
   *
   * ★길이 트레이드오프: Node 의 worker.terminate() 는 동기 V8 정규식 실행(backtracking)을 즉시
   * 중단하지 못해, 워치독이 응답한 뒤에도 worker 스레드는 probe 매칭이 끝날 때까지 좀비로 CPU 를
   * 태운다. 좀비 시간은 입력 길이가 지배하므로(문자 다양성과 무관), 각 probe 를 ★bounded 길이
   * (~28-40자)로 둬 누적 좀비 상한을 유지하면서도 100ms 워치독을 압도적으로 초과(예: `(a+)+$` 에
   * 수초~수십초)해 unsafe 판정이 정확하다.
   */
  static readonly PROBE_INPUTS: readonly string[] = [
    // ★각 probe 는 ★단일 문자클래스의 연속 run + 매칭 실패 트레일러('!')다. catastrophic
    // nested-quantifier 는 자기 클래스의 ★연속 run 에서만 폭발하므로(예: `(b+)+$` 는 'b' 가
    // 끊기지 않는 run 에서만 지수 backtracking — 'b2,b2,' 처럼 구분자가 끼면 폭발 안 함),
    // 클래스별로 분리한 연속 run probe 를 둔다. 길이 22 는 실측상 모든 클래스 catastrophic 을
    // 100ms 워치독 위(≈130ms~1.4s)로 확실히 초과시키면서 좀비 시간을 ~1.4s 로 bound 한다.
    'a'.repeat(22) + '!', // 영문 소문자 run — (a+)+$ 류.
    'A'.repeat(22) + '!', // 영문 대문자 run — ([A-Z]+)*$ 류.
    '1'.repeat(22) + '!', // 숫자 run — (\d+)+$ 류.
    'b'.repeat(22) + '!', // 또 다른 소문자 run — (b+)+$ 류(영문 'a' 외 클래스 커버).
    ' '.repeat(22) + '!', // 공백 run — (\s+)*$ 류.
  ];
  /**
   * 단일 probe 가 필요한 경로(worker 1회 왕복)용 대표 probe. 가장 흔한 'a' 반복 catastrophic 을
   * 잡되, 검증은 PROBE_INPUTS 전체를 순차로 돈다(validateSafety/validateRegexSafetyInline).
   */
  static readonly PROBE_INPUT = AutoModRegexRunner.PROBE_INPUTS[0];

  /** persistent 매칭 worker(요청마다 spawn 하지 않고 재사용 · terminate 후 lazy respawn). */
  private matchWorker: Worker | null = null;
  /**
   * MED-2 (069 fix-forward): 현재 worker 의 'online' 대기 Promise. worker spawn(최초/respawn)마다
   * 새로 만들고, match/validate 가 첫 사용 시 이를 await 해 cold start(eval 컴파일·스레드 기동)가
   * 끝나길 기다린다 — 워치독 terminate 후 lazy respawn 한 worker 의 첫 match 가 cold start 로
   * 10ms 워치독을 초과해 spurious AUTOMOD_TIMEOUT + fail-open(정상 메시지가 룰 회피)되던 회귀 차단.
   */
  private workerReady: Promise<void> | null = null;
  /** worker resolve 가 영구 불가(파일 없음)면 더 시도하지 않는다(매번 fail-open). */
  private resolveFailed = false;
  private reqSeq = 0;
  /** in-flight 매칭 요청의 resolver(id → resolve). worker 응답/종료 시 정리. */
  private readonly pending = new Map<number, (matched: string | null) => void>();

  /**
   * FR-RM10b: worker warm-up. 첫 매칭에서 worker cold start(eval 컴파일·스레드 기동 수십 ms)가
   * 10ms 매칭 워치독을 초과해 정상 매칭이 fail-open(timedOut) 되는 회귀를 막는다. 'online'
   * 이벤트까지 기다려 worker 가 메시지를 받을 준비를 마치게 한다(best-effort — 실패해도 lazy
   * spawn 으로 폴백).
   */
  async onModuleInit(): Promise<void> {
    this.ensureMatchWorker();
    await this.awaitWorkerReady();
  }

  /**
   * MED-2 (069 fix-forward): 현재 worker 가 online(메시지 처리 준비 완료)될 때까지 기다린다(최대
   * 100ms 안전 타이머). warm-up(onModuleInit) + match/validate 첫 사용이 함께 호출해, 최초/respawn
   * worker 의 cold start 가 매칭 워치독을 잡아먹는 spurious timeout 을 막는다. workerReady 가 없으면
   * (worker 미가용) 즉시 resolve.
   */
  private async awaitWorkerReady(): Promise<void> {
    if (this.workerReady) await this.workerReady;
  }

  private ensureMatchWorker(): Worker | null {
    if (this.matchWorker) return this.matchWorker;
    if (this.resolveFailed) return null;
    try {
      // ★인라인 eval worker — prod/dev/vitest/int 동일 동작(경로 resolve·loader 불요).
      const worker = new Worker(WORKER_SOURCE, { eval: true });
      // MED-2: spawn(최초/respawn)마다 online 대기 Promise 를 새로 만든다. 첫 match/validate 가
      // 이를 await 해 cold start 를 흡수한다(안전 타이머 100ms — online 이 안 와도 영구 대기 방지).
      this.workerReady = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 100);
        worker.once('online', () => {
          clearTimeout(timer);
          resolve();
        });
        // worker 가 online 전에 죽으면(즉시 종료) 영구 대기하지 않도록 exit 로도 해제.
        worker.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      worker.on('message', (msg: AutoModRegexWorkerResponse) => {
        if (msg.kind !== 'match') return;
        const resolve = this.pending.get(msg.id);
        if (resolve) {
          this.pending.delete(msg.id);
          resolve(msg.matched);
        }
      });
      worker.on('error', (err) => {
        this.logger.warn(`[automod] regex worker error: ${String(err).slice(0, 160)}`);
        this.failAllPending();
        this.matchWorker = null;
        this.workerReady = null;
      });
      worker.on('exit', () => {
        // terminate 또는 비정상 종료. in-flight 는 fail-open 으로 닫고 lazy respawn 한다.
        this.failAllPending();
        this.matchWorker = null;
        this.workerReady = null;
      });
      this.matchWorker = worker;
      return worker;
    } catch (err) {
      this.resolveFailed = true;
      this.logger.warn(`[automod] regex worker spawn failed: ${String(err).slice(0, 160)}`);
      return null;
    }
  }

  /** in-flight 매칭 요청을 전부 fail-open(매칭 없음)으로 닫는다(worker 종료/에러 시). */
  private failAllPending(): void {
    for (const [, resolve] of this.pending) resolve(null);
    this.pending.clear();
  }

  /**
   * FR-RM10b: sources 정규식들을 content 에 매칭한다(첫 매칭 source 반환).
   *
   * @returns matched: 매칭된 정규식 source(없으면 null) · timedOut: 워치독 초과로 worker 를
   *   강제 종료했는지(true 면 호출부가 AUTOMOD_TIMEOUT audit). worker resolve/spawn 실패는
   *   fail-open({matched:null,timedOut:false}).
   */
  async match(
    sources: string[],
    content: string,
  ): Promise<{ matched: string | null; timedOut: boolean }> {
    if (sources.length === 0) return { matched: null, timedOut: false };
    const worker = this.ensureMatchWorker();
    if (!worker) return { matched: null, timedOut: false };
    // MED-2: respawn/cold worker 의 첫 match 가 eval 컴파일·스레드 기동(수십 ms)으로 10ms 워치독을
    // 초과해 spurious AUTOMOD_TIMEOUT(fail-open)되지 않도록, 매칭 워치독을 걸기 전에 online 을 기다린다.
    await this.awaitWorkerReady();

    const id = ++this.reqSeq;
    const req: AutoModRegexWorkerRequest = { kind: 'match', id, sources, content };

    const matchPromise = new Promise<string | null>((resolve) => {
      this.pending.set(id, resolve);
      worker.postMessage(req);
    });

    let timer: NodeJS.Timeout | undefined;
    const watchdog = new Promise<'__timeout__'>((resolve) => {
      timer = setTimeout(() => resolve('__timeout__'), AutoModRegexRunner.MATCH_WATCHDOG_MS);
    });

    const result = await Promise.race([matchPromise, watchdog]);
    if (timer) clearTimeout(timer);

    if (result === '__timeout__') {
      // 워치독 초과 — backtracking 중인 worker 를 강제 종료(메인 루프 무영향). exit 핸들러가
      // pending 을 fail-open 으로 닫고 다음 호출에서 respawn 한다.
      this.pending.delete(id);
      void worker.terminate();
      this.matchWorker = null;
      return { matched: null, timedOut: true };
    }
    return { matched: result, timedOut: false };
  }

  /**
   * FR-RM10b: 정규식 룰 저장 시 ReDoS 안전성 검증. ★복수 probe(PROBE_INPUTS — 영문/숫자/구분자/
   * 공백 혼합)를 순차로 worker 격리 매칭하고, 그중 하나라도 100ms 워치독을 초과하거나 컴파일이
   * 불가하면 unsafe(false). 모든 probe 가 워치독 내 통과하면 safe(true).
   *
   * worker resolve 실패(미가용) 시에만 ★메인스레드 인라인 폴백(validateRegexSafetyInline)을 쓴다
   * (검증은 거부 우선이라 skip 금지). worker 가 spawn 됐다면 어떤 경로(타임아웃/exit)에서도
   * 메인스레드에서 catastrophic 패턴을 동기 재실행하지 않는다 — 아래 BLOCKER 주석 참조.
   *
   * @returns true=안전(저장 허용) · false=unsafe(REGEX_UNSAFE 400).
   */
  async validateSafety(source: string): Promise<boolean> {
    // worker 미가용(애초에 spawn 실패) 경로에서만 인라인 폴백을 쓴다. terminate 후엔 절대 호출 안 함.
    if (!this.ensureMatchWorker()) {
      return validateRegexSafetyInline(source);
    }
    // 컴파일 자체가 불가하면 worker 왕복 없이 즉시 unsafe(좀비 spawn 회피).
    try {
      new RegExp(source);
    } catch {
      return false;
    }
    // MED-2: cold worker 의 첫 검증도 online 을 기다린다(워치독은 100ms 라 영향은 작지만 일관성).
    await this.awaitWorkerReady();
    for (const probe of AutoModRegexRunner.PROBE_INPUTS) {
      if (!(await this.validateSingleProbe(source, probe))) return false;
    }
    return true;
  }

  /**
   * ★BLOCKER (069 fix-forward · 보안): 단일 probe 에 대한 worker 격리 검증. 메인 이벤트 루프에서
   * catastrophic 정규식을 동기 재실행하는 경로를 전부 제거한다.
   *
   * 종전 결함: 워치독 타임아웃 시 worker.terminate() 가 `exit` 를 발화 → executor 안의 onExit 가
   * `validateRegexSafetyInline(source)` 를 메인스레드에서 동기 실행해, 방금 worker 에서 죽인 그
   * catastrophic 패턴을 메인 루프에서 다시 돌렸다(격리 무력화 · 이벤트 루프 stall). 또 성공 경로의
   * onMessage 가 exit 리스너를 detach 하지 않아 검증마다 dangling 리스너가 누적됐다.
   *
   * 수정: onMessage/onExit 를 executor 밖으로 hoist 해 모든 경로에서 detach 가능하게 하고,
   *   - 성공(onMessage): message + exit 리스너 둘 다 off → ok 로 resolve.
   *   - 워치독 타임아웃: terminate **전에** message + exit 리스너 둘 다 off 후 terminate → ★인라인
   *     폴백 없이 그대로 false(의도적 watchdog-kill = unsafe 확정 · 메인스레드 재실행 금지).
   *   - exit(다른 이유로 worker 종료): 검증 불가 → ★보수적으로 false(거부 우선 · 메인스레드 동기
   *     재실행 회피). worker 는 다음 ensureMatchWorker 에서 lazy respawn 된다.
   */
  private validateSingleProbe(source: string, probe: string): Promise<boolean> {
    const worker = this.ensureMatchWorker();
    if (!worker) return Promise.resolve(validateRegexSafetyInline(source, undefined, probe));
    const id = ++this.reqSeq;
    const req: AutoModRegexWorkerRequest = { kind: 'validate', id, source, probe };

    let timer: NodeJS.Timeout | undefined;
    return new Promise<boolean>((resolve) => {
      // hoist: 모든 경로에서 두 리스너를 함께 detach 할 수 있게 한다(리스너 누수 방지).
      const detach = (): void => {
        worker.off('message', onMessage);
        worker.off('exit', onExit);
        if (timer) clearTimeout(timer);
      };
      const onMessage = (msg: AutoModRegexWorkerResponse): void => {
        if (msg.kind !== 'validate' || msg.id !== id) return;
        detach();
        resolve(msg.ok);
      };
      // worker 가 다른 이유(다른 match 워치독에 죽음 등)로 종료 → 검증 불가. ★메인스레드 동기
      // 재실행 절대 금지 → 보수적으로 unsafe(false). lazy respawn 은 ensureMatchWorker 가 처리.
      const onExit = (): void => {
        detach();
        this.matchWorker = null;
        resolve(false);
      };
      worker.on('message', onMessage);
      worker.on('exit', onExit);
      timer = setTimeout(() => {
        // 워치독 초과 = ReDoS 위험 → unsafe 확정. terminate **전에** 리스너를 detach 해 exit 가
        // 발화해도 onExit 가 돌지 않게 하고(인라인 재실행 차단), 그 다음 terminate 한다.
        detach();
        this.matchWorker = null;
        this.failAllPending();
        void worker.terminate();
        resolve(false);
      }, AutoModRegexRunner.VALIDATE_WATCHDOG_MS);
      worker.postMessage(req);
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.failAllPending();
    this.workerReady = null;
    if (this.matchWorker) {
      await this.matchWorker.terminate();
      this.matchWorker = null;
    }
  }
}

/**
 * FR-RM10b: 메인스레드 인라인 ReDoS 검증(worker resolve 폴백 · 단위 테스트용 순수 함수).
 *
 * ★격리가 아니라 동기 워치독이라 catastrophic backtracking 이면 이 함수 자체가 100ms 이상
 * 메인스레드를 막을 수 있다(이것이 worker 격리가 1차인 이유). 그러나 worker 가 미가용한
 * 환경(vitest·worker 파일 부재)에서 위험 패턴을 그대로 통과시키는 것보다는, 1회성 동기
 * 워치독으로 거부하는 편이 안전하다. 컴파일 실패 또는 probe 매칭이 100ms 초과 시 false.
 *
 * ★HIGH (069 fix-forward): probe 를 명시하지 않으면 ★PROBE_INPUTS 전체(영문/숫자/구분자/공백
 * 혼합)를 순회해, 어느 하나라도 워치독을 초과하면 unsafe 로 본다 — worker 경로의 다문자 probe
 * 와 동일 커버리지(`(b+)+$`·`(\d+)+$` 등 비-'a' catastrophic 도 거른다). probe 를 명시하면 그
 * 단일 probe 만 검증한다(worker 폴백·단위 테스트가 결정적 입력을 지정하는 경로).
 *
 * 구현: Date.now() 로 경과를 측정하되, JS 정규식 엔진은 동기·블로킹이라 test() 가 반환되기
 * 전엔 시간 체크가 불가하다. 따라서 (1) 먼저 컴파일을 시도하고 (2) probe 에 대해 test() 를
 * 실행한 뒤 (3) 소요 시간이 워치독을 초과했으면 unsafe 로 본다. catastrophic 패턴은 test()
 * 자체가 오래 걸려 경과가 워치독을 크게 넘으므로 false 로 거른다(이미 그 시간만큼은 소비된
 * 뒤지만 1회 한정 · 룰 저장 경로라 hot-path 아님).
 */
export function validateRegexSafetyInline(
  source: string,
  watchdogMs: number = AutoModRegexRunner.VALIDATE_WATCHDOG_MS,
  probe?: string,
): boolean {
  let re: RegExp;
  try {
    re = new RegExp(source);
  } catch {
    return false; // 컴파일 실패 = unsafe.
  }
  // probe 미지정이면 PROBE_INPUTS 전체를, 지정되면 그 단일 probe 만 검증한다.
  const probes = probe !== undefined ? [probe] : AutoModRegexRunner.PROBE_INPUTS;
  for (const p of probes) {
    const start = Date.now();
    try {
      re.test(p);
    } catch {
      return false;
    }
    if (Date.now() - start > watchdogMs) return false;
  }
  return true;
}
