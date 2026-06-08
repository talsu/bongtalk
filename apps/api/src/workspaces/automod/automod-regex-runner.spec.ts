import { describe, it, expect } from 'vitest';
import { AutoModRegexRunner, validateRegexSafetyInline } from './automod-regex-runner';

/**
 * FR-RM10b (069) 단위 테스트 — 인라인 ReDoS 검증(순수 함수) + ★HIGH 다문자 probe.
 *
 * worker_threads 격리 매칭/검증(AutoModRegexRunner.match/validateSafety)은 실제 eval worker 를
 * 띄운다. 단위(vitest fork/swc)에서 worker 를 띄우면 (1) worker 시작·메시지 왕복이 vitest pool 과
 * 충돌해 비결정적이고 (2) catastrophic 패턴은 worker.terminate() 가 동기 V8 정규식 실행을 즉시 못
 * 멈춰 좀비 스레드가 teardown 시 SIGSEGV/hang 을 유발한다. 따라서 worker 경로의 end-to-end
 * (★BLOCKER: 워치독 타임아웃·exit 경로에서 메인스레드 인라인 재실행 없음 + 리스너 누수 없음, 매칭,
 * REGEX_UNSAFE 저장 거부, spam)는 int(frrm10b-automod.int.spec)에 맡기고, 여기선 워치독 판정의 순수
 * 로직(validateRegexSafetyInline)과 probe 세트 구성만 결정적으로 검증한다.
 */

describe('validateRegexSafetyInline', () => {
  it('flags a syntactically invalid regex as unsafe', () => {
    // unbalanced group → new RegExp throws → unsafe.
    expect(validateRegexSafetyInline('(unclosed')).toBe(false);
    expect(validateRegexSafetyInline('a{2,1}')).toBe(false);
  });

  it('flags catastrophic backtracking as unsafe (watchdog exceeded)', () => {
    // 고전 nested-quantifier — 'a' 반복. probe 명시로 짧게(20 a + '!') 둬 결정성 확보.
    // 인라인 검증은 elapsed > watchdog 판정이다(probe 가 길면 검증 자체가 수초~수십초 — 단위 부적합).
    const probe = 'a'.repeat(20) + '!';
    expect(validateRegexSafetyInline('(a+)+$', 5, probe)).toBe(false);
    expect(validateRegexSafetyInline('([a-z]+)*$', 5, probe)).toBe(false);
  });

  it('★HIGH: flags non-"a" catastrophic patterns via the multi-char probe set', () => {
    // ★probe 미지정 → PROBE_INPUTS 전체(영문 소/대문자·숫자·공백의 ★연속 run) 순회. 종전 단일 'a'
    // probe 는 아래 패턴들을 0ms(통과)로 오판해 저장 → match 시 fail-open 으로 룰을 무력화했다.
    // 각 클래스 run probe 로 전부 unsafe(false) 판정. 워치독을 작게(2ms) 둬 결정적으로 초과를 잡는다
    // (실측: 각 패턴이 자기 클래스 22-run probe 에서 ≈130ms+ — 2ms 워치독 압도적 초과).
    expect(validateRegexSafetyInline('(b+)+$', 2)).toBe(false); // 'b'×22 run 이 폭발.
    expect(validateRegexSafetyInline('(\\d+)+$', 2)).toBe(false); // '1'×22 run 이 폭발.
    expect(validateRegexSafetyInline('([A-Z]+)*$', 2)).toBe(false); // 'A'×22 run 이 폭발.
    expect(validateRegexSafetyInline('(\\s+)*$', 2)).toBe(false); // ' '×22 run 이 폭발.
  });

  it('accepts a safe regex (no catastrophic backtracking)', () => {
    const probe = 'a'.repeat(20) + '!';
    // 단순 리터럴/문자클래스/앵커는 선형 시간 — 워치독 내 완료.
    expect(validateRegexSafetyInline('spam', 100, probe)).toBe(true);
    expect(validateRegexSafetyInline('^[a-z]+$', 100, probe)).toBe(true);
    expect(validateRegexSafetyInline('https?://\\S+', 100, probe)).toBe(true);
  });

  it('accepts a safe regex with the default (multi) probe set', () => {
    // 선형 패턴은 PROBE_INPUTS 전체에 대해 빠르게 끝난다(기본 100ms 워치독).
    expect(validateRegexSafetyInline('forbidden')).toBe(true);
    expect(validateRegexSafetyInline('https?://\\S+')).toBe(true);
    expect(validateRegexSafetyInline('^[a-z0-9]+$')).toBe(true);
  });
});

describe('AutoModRegexRunner.PROBE_INPUTS (★HIGH multi-char coverage)', () => {
  it('mixes multiple character classes (not just "a")', () => {
    // probe 세트가 영문 소/대문자·숫자·공백의 연속 run 을 포함해야 비-'a' catastrophic 을 잡는다.
    const joined = AutoModRegexRunner.PROBE_INPUTS.join('');
    expect(/[a-z]/.test(joined)).toBe(true);
    expect(/[A-Z]/.test(joined)).toBe(true);
    expect(/\d/.test(joined)).toBe(true);
    expect(/\s/.test(joined)).toBe(true);
    // 여러 probe 세트(하나라도 워치독 초과면 unsafe).
    expect(AutoModRegexRunner.PROBE_INPUTS.length).toBeGreaterThanOrEqual(3);
  });

  it('keeps each probe bounded in length (zombie-time cap)', () => {
    // 좀비 시간은 입력 길이 지배 — 길이를 상한(≤40)해 누적 좀비를 bound 한다(실측 최악 ≈1.4s).
    for (const p of AutoModRegexRunner.PROBE_INPUTS) {
      expect(p.length).toBeGreaterThanOrEqual(20);
      expect(p.length).toBeLessThanOrEqual(40);
    }
    // 대표 단일 probe 는 세트의 첫 원소('a' run).
    expect(AutoModRegexRunner.PROBE_INPUT).toBe(AutoModRegexRunner.PROBE_INPUTS[0]);
  });
});
