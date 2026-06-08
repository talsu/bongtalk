import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  buildBoundedText,
  matchesKeyword,
  scanKeywords,
  type KeywordWatcher,
} from './keyword-matcher';

beforeEach(() => {
  // 결정적 시간(harness 규약). 이 매처는 시간에 의존하지 않지만 일관성을 위해 고정.
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('FR-MN-10 buildBoundedText', () => {
  it('소문자화 + 연속 공백 단일화 + sentinel 공백으로 감싼다', () => {
    expect(buildBoundedText('Hello   World')).toBe(' hello world ');
  });

  it('빈/공백뿐/null 본문은 빈 문자열', () => {
    expect(buildBoundedText('')).toBe('');
    expect(buildBoundedText('   ')).toBe('');
    expect(buildBoundedText(null)).toBe('');
    expect(buildBoundedText(undefined)).toBe('');
  });
});

describe('FR-MN-10 matchesKeyword — 어절 정확 일치(whole-word)', () => {
  const bounded = buildBoundedText("let's deploy now");

  it('어절 정확 일치는 true', () => {
    expect(matchesKeyword(bounded, 'deploy')).toBe(true);
  });

  it('substring 은 불일치 — "redeploys" 에 "deploy" 는 false', () => {
    expect(matchesKeyword(buildBoundedText('we had redeploys today'), 'deploy')).toBe(false);
  });

  it('대소문자 무관 — 키워드/본문 케이스 달라도 일치', () => {
    expect(matchesKeyword(buildBoundedText('DEPLOY the thing'), 'Deploy')).toBe(true);
    expect(matchesKeyword(buildBoundedText('please Deploy'), 'DEPLOY')).toBe(true);
  });

  it('첫/마지막 어절도 경계로 인식', () => {
    expect(matchesKeyword(buildBoundedText('deploy'), 'deploy')).toBe(true);
    expect(matchesKeyword(buildBoundedText('time to deploy'), 'deploy')).toBe(true);
  });

  it('다어절 키워드("code review")는 어절 시퀀스로 일치', () => {
    expect(matchesKeyword(buildBoundedText('please do a code review today'), 'code review')).toBe(
      true,
    );
    // 어절 순서가 다르면 불일치
    expect(matchesKeyword(buildBoundedText('review the code now'), 'code review')).toBe(false);
  });

  it('다어절 키워드 내부 공백이 여러 칸이어도 정규화 후 일치', () => {
    expect(matchesKeyword(buildBoundedText('a code review'), 'code   review')).toBe(true);
  });

  it('구두점 인접 어절은 strict whitespace 정의대로 불일치 — "deploy!" ≠ "deploy"', () => {
    expect(matchesKeyword(buildBoundedText('please deploy! now'), 'deploy')).toBe(false);
  });

  it('빈/공백뿐 키워드는 항상 false', () => {
    expect(matchesKeyword(bounded, '')).toBe(false);
    expect(matchesKeyword(bounded, '   ')).toBe(false);
  });

  it('빈 bounded 텍스트는 항상 false', () => {
    expect(matchesKeyword('', 'deploy')).toBe(false);
  });

  it('키워드 양끝 공백은 trim 후 일치', () => {
    expect(matchesKeyword(buildBoundedText('time to deploy'), '  deploy  ')).toBe(true);
  });
});

describe('FR-MN-10 scanKeywords — watcher 집계', () => {
  const watchers: KeywordWatcher[] = [
    { userId: 'u-1', keywords: ['deploy', 'incident'] },
    { userId: 'u-2', keywords: ['code review'] },
    { userId: 'u-3', keywords: ['outage'] },
  ];

  it('일치한 키워드를 가진 watcher 만 모은다', () => {
    const matched = scanKeywords("let's deploy after code review", watchers);
    expect([...matched].sort()).toEqual(['u-1', 'u-2']);
  });

  it('일치 없으면 빈 집합', () => {
    expect(scanKeywords('nothing relevant here', watchers).size).toBe(0);
  });

  it('빈 본문이면 빈 집합', () => {
    expect(scanKeywords('', watchers).size).toBe(0);
    expect(scanKeywords(null, watchers).size).toBe(0);
  });

  it('빈 watcher 목록이면 빈 집합', () => {
    expect(scanKeywords('deploy now', []).size).toBe(0);
  });

  it('한 watcher 의 여러 키워드 중 하나만 일치해도 채택(첫 일치에서 단락)', () => {
    const matched = scanKeywords('major incident reported', watchers);
    expect([...matched]).toEqual(['u-1']);
  });

  it('substring 일치는 watcher 채택 안 함', () => {
    // "redeploys" 는 "deploy" 의 superstring → u-1 미채택
    expect(scanKeywords('many redeploys today', watchers).size).toBe(0);
  });
});
