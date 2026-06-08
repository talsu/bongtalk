/**
 * FR-RM10b (069 / ADR E1): AutoMod 정규식 매칭/검증 worker_threads 엔트리.
 *
 * 정규식 컴파일·실행을 메인 이벤트 루프에서 격리한다(ReDoS 방어 — catastrophic backtracking
 * 이 worker 스레드만 점유). 워치독(타임아웃)은 worker *바깥*(runner)이 Promise.race +
 * worker.terminate() 로 강제하므로, 본 worker 는 단순히 요청을 수행하고 결과를 postMessage
 * 한다. terminate 되면 이 스레드의 무한 backtracking 도 함께 사라진다(메인 루프 무영향).
 *
 * 두 작업 종류(WorkerRequest.kind):
 *   'match'    — sources[] 정규식들을 content 에 대해 순서대로 test() → 첫 매칭 source 반환.
 *   'validate' — 단일 source 를 컴파일 후 probe(병리적 입력)에 test() → 컴파일/실행 가능 여부.
 *
 * ★이 파일은 worker 의 동작 로직·메시지 타입(WorkerRequest/Response)의 정본이지만 런타임에
 * 직접 로드되지 않는다. runner(automod-regex-runner.ts)가 동일 로직을 인라인 JS 문자열
 * (WORKER_SOURCE)로 들고 `new Worker(src,{eval:true})` 로 띄운다 — 경로 resolve·loader 가
 * 필요 없어 prod/dev/vitest/int 가 동일하게 동작한다(타입은 여기서 import type 으로 공유).
 * WORKER_SOURCE 를 수정하면 이 파일의 handleMatch/handleValidate 도 함께 맞춰 둔다(정본 일치).
 */
import { parentPort } from 'node:worker_threads';

/** runner → worker 요청. */
export type AutoModRegexWorkerRequest =
  | { kind: 'match'; id: number; sources: string[]; content: string }
  | { kind: 'validate'; id: number; source: string; probe: string };

/** worker → runner 응답. */
export type AutoModRegexWorkerResponse =
  | { kind: 'match'; id: number; matched: string | null }
  | { kind: 'validate'; id: number; ok: boolean };

function handleMatch(sources: string[], content: string): string | null {
  for (const src of sources) {
    let re: RegExp;
    try {
      re = new RegExp(src);
    } catch {
      // 컴파일 불가 패턴은 저장 시 검증으로 걸러지지만, 방어적으로 건너뛴다(매칭 없음).
      continue;
    }
    // ReDoS 가능 패턴이라도 이 test() 는 worker 안에서 실행되며, 초과 시 runner 워치독이
    // 이 스레드를 terminate 한다(메인 루프 무영향).
    if (re.test(content)) return src;
  }
  return null;
}

function handleValidate(source: string, probe: string): boolean {
  let re: RegExp;
  try {
    re = new RegExp(source);
  } catch {
    return false; // 컴파일 실패 = unsafe.
  }
  // 병리적 입력에 대해 매칭을 시도한다. catastrophic backtracking 이면 여기서 멈추고
  // runner 의 100ms 워치독이 terminate → unsafe 판정. 정상 종료하면 ok=true.
  re.test(probe);
  return true;
}

if (parentPort !== null) {
  const port = parentPort;
  port.on('message', (msg: AutoModRegexWorkerRequest) => {
    if (msg.kind === 'match') {
      const matched = handleMatch(msg.sources, msg.content);
      const res: AutoModRegexWorkerResponse = { kind: 'match', id: msg.id, matched };
      port.postMessage(res);
      return;
    }
    // validate
    const ok = handleValidate(msg.source, msg.probe);
    const res: AutoModRegexWorkerResponse = { kind: 'validate', id: msg.id, ok };
    port.postMessage(res);
  });
}
