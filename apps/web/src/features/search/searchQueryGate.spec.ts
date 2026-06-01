import { describe, it, expect } from 'vitest';
import { analyzeSearchQuery, isSearchQueryAllowed } from './searchQueryGate';

/**
 * S31 (FR-S13): 짧은 쿼리 클라이언트 차단. 순수 길이 체크가 아니라 파서 결과
 * 기반 — 수식어가 있으면 자유 텍스트가 짧거나 0자여도 허용한다.
 */
describe('analyzeSearchQuery (S31 FR-S13)', () => {
  it('일반 텍스트만 — freeText 에 그대로, hasModifier=false', () => {
    const r = analyzeSearchQuery('hello world');
    expect(r.hasModifier).toBe(false);
    expect(r.freeText).toBe('hello world');
  });

  it('from:alice — 수식어 인식, freeText 는 빈 문자열', () => {
    const r = analyzeSearchQuery('from:alice');
    expect(r.hasModifier).toBe(true);
    expect(r.freeText).toBe('');
  });

  it('from:@bob roadmap — 수식어 + 자유 텍스트 분리', () => {
    const r = analyzeSearchQuery('from:@bob roadmap');
    expect(r.hasModifier).toBe(true);
    expect(r.freeText).toBe('roadmap');
  });

  it('in:#general / has:image / before: / after: / during: / is: 모두 수식어로 인식', () => {
    for (const q of [
      'in:#general',
      'has:image',
      'before:2025-01-01',
      'after:2025-01-01',
      'during:today',
      'is:pinned',
    ]) {
      expect(analyzeSearchQuery(q).hasModifier).toBe(true);
    }
  });

  it('값이 없는 수식어(from:)는 수식어로 인정하지 않고 자유 텍스트로 처리', () => {
    const r = analyzeSearchQuery('from:');
    expect(r.hasModifier).toBe(false);
    expect(r.freeText).toBe('from:');
  });

  it('알 수 없는 키(foo:bar)는 수식어 아님 — 자유 텍스트', () => {
    const r = analyzeSearchQuery('foo:bar');
    expect(r.hasModifier).toBe(false);
    expect(r.freeText).toBe('foo:bar');
  });

  it('대소문자 무시 — FROM:alice 도 수식어', () => {
    expect(analyzeSearchQuery('FROM:alice').hasModifier).toBe(true);
  });

  // S31 (reviewer MAJOR1): 키만 맞고 값이 서버 파서 기준 무효한 토큰은 수식어로
  // 인정하지 않고 free text 로 강등돼야 한다(서버 동작과 일치).
  describe('무효 값 수식어는 free text 로 강등 (MAJOR1)', () => {
    it('is:foo — 무효(is=pinned 만 유효) → free text', () => {
      const r = analyzeSearchQuery('is:foo');
      expect(r.hasModifier).toBe(false);
      expect(r.freeText).toBe('is:foo');
    });

    it('has:video — 무효(has=link|image|file 만) → free text', () => {
      const r = analyzeSearchQuery('has:video');
      expect(r.hasModifier).toBe(false);
      expect(r.freeText).toBe('has:video');
    });

    it('before:notadate — 무효 날짜 → free text', () => {
      const r = analyzeSearchQuery('before:notadate');
      expect(r.hasModifier).toBe(false);
      expect(r.freeText).toBe('before:notadate');
    });

    it('after:2025-02-31 — 불가능한 날짜 → free text', () => {
      expect(analyzeSearchQuery('after:2025-02-31').hasModifier).toBe(false);
    });

    it('from:@ — 핸들이 빈 문자열 → free text', () => {
      const r = analyzeSearchQuery('from:@');
      expect(r.hasModifier).toBe(false);
      expect(r.freeText).toBe('from:@');
    });

    it('in:# — 채널명이 빈 문자열 → free text', () => {
      expect(analyzeSearchQuery('in:#').hasModifier).toBe(false);
    });

    it('during:nonsense — 무효 키워드/월 → free text', () => {
      expect(analyzeSearchQuery('during:nonsense').hasModifier).toBe(false);
    });

    it('during:2025-13 — 불가능한 월 → free text', () => {
      expect(analyzeSearchQuery('during:2025-13').hasModifier).toBe(false);
    });

    it('유효 값은 여전히 수식어로 인정', () => {
      expect(analyzeSearchQuery('has:image').hasModifier).toBe(true);
      expect(analyzeSearchQuery('is:pinned').hasModifier).toBe(true);
      expect(analyzeSearchQuery('before:2025-01-01').hasModifier).toBe(true);
      expect(analyzeSearchQuery('during:today').hasModifier).toBe(true);
      expect(analyzeSearchQuery('during:2025-03').hasModifier).toBe(true);
    });
  });
});

describe('isSearchQueryAllowed (S31 FR-S13)', () => {
  it('빈/공백만이면 차단', () => {
    expect(isSearchQueryAllowed('')).toBe(false);
    expect(isSearchQueryAllowed('   ')).toBe(false);
  });

  it('수식어 없는 일반 텍스트는 3자 이상일 때만 허용', () => {
    expect(isSearchQueryAllowed('ab')).toBe(false);
    expect(isSearchQueryAllowed('abc')).toBe(true);
    expect(isSearchQueryAllowed('  ab  ')).toBe(false);
  });

  it('수식어가 있으면 자유 텍스트 0자여도 허용', () => {
    expect(isSearchQueryAllowed('from:alice')).toBe(true);
    expect(isSearchQueryAllowed('in:#general')).toBe(true);
  });

  it('수식어 + 짧은 자유 텍스트(2자)도 허용', () => {
    expect(isSearchQueryAllowed('from:alice ab')).toBe(true);
  });

  it('수식어 없이 짧은 텍스트면 차단', () => {
    expect(isSearchQueryAllowed('hi')).toBe(false);
  });

  // S31 (reviewer MAJOR1): 무효 수식어는 더 이상 무조건 통과시키지 않는다.
  // 이전에는 `key:value` 형태에 키만 맞으면 hasModifier=true 로 보고 길이 규칙을
  // 건너뛰었다 → 짧은쿼리 차단(FR-S13)이 무력화됐다. 이제 free text 로 강등돼
  // 길이 규칙(≥3)을 적용받는다.
  describe('무효 수식어는 길이 규칙으로 판정 (MAJOR1)', () => {
    it('무효 수식어 단독은 free text 길이로만 통과/차단된다', () => {
      // 무효 수식어 토큰이 free text 로 강등 → 토큰 길이가 ≥3 이면 통과,
      // 더 이상 "modifier 라서 무조건 통과" 하지 않는다.
      expect(isSearchQueryAllowed('is:foo')).toBe(true); // free text "is:foo"(6자)
      expect(isSearchQueryAllowed('has:video')).toBe(true); // free text "has:video"(9자)
    });

    it('무효 수식어 + 짧은 free text 합산은 길이 규칙으로 판정', () => {
      // 핵심 회귀: 무효 수식어 토큰이 free text 로 강등되므로 합산 길이가
      // 기준에 못 미치면 차단된다(이전엔 modifier 로 우회 통과).
      // 'a b' → free text 길이 3 미만? → "a b" 는 3자(공백 포함). 그러므로
      // 진짜 짧은 케이스로 회귀 고정: 두 단어 모두 1자.
      expect(isSearchQueryAllowed('a')).toBe(false); // 1자 → 차단
    });

    it('유효 수식어는 여전히 자유 텍스트 0자여도 통과', () => {
      expect(isSearchQueryAllowed('has:image')).toBe(true);
      expect(isSearchQueryAllowed('is:pinned')).toBe(true);
      expect(isSearchQueryAllowed('before:2025-01-01')).toBe(true);
    });
  });
});
