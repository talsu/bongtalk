import { describe, it, expect } from 'vitest';
import { parseSearchQuery } from '../../../src/search/search-query.parser';

/**
 * S29 (FR-S05): 검색 수식어 파서 단위 검증.
 *  - from/in/has/is/before/after/during 토큰 추출 + 잔여 텍스트.
 *  - 복합 AND(여러 modifier 동시).
 *  - 알 수 없는 modifier 는 텍스트로 degrade(400 던지지 않음).
 */

const NOW = new Date('2025-01-15T12:34:00Z'); // 결정적 기준 시각.

describe('parseSearchQuery (S29 FR-S05)', () => {
  it('순수 텍스트는 text 로, modifier 없음', () => {
    const r = parseSearchQuery('hello world', NOW);
    expect(r.text).toBe('hello world');
    expect(r.fromHandle).toBeUndefined();
    expect(r.inChannel).toBeUndefined();
    expect(r.has).toEqual([]);
    expect(r.isPinned).toBe(false);
  });

  it('from:@user 핸들 추출(앞의 @ 제거) + 텍스트 분리', () => {
    const r = parseSearchQuery('deploy from:@alice', NOW);
    expect(r.fromHandle).toBe('alice');
    expect(r.text).toBe('deploy');
  });

  it('in:#channel 채널명 추출(앞의 # 제거)', () => {
    const r = parseSearchQuery('in:#general budget', NOW);
    expect(r.inChannel).toBe('general');
    expect(r.text).toBe('budget');
  });

  it('S29 security LOW: from:@<64자 초과> 는 modifier 미인정 → 자유 텍스트 degrade', () => {
    const longHandle = 'x'.repeat(65);
    const token = `from:@${longHandle}`;
    const r = parseSearchQuery(`${token} budget`, NOW);
    expect(r.fromHandle).toBeUndefined();
    expect(r.text).toBe(`${token} budget`);
  });

  it('S29 security LOW: in:#<64자 초과> 는 modifier 미인정 → 자유 텍스트 degrade', () => {
    const longName = 'y'.repeat(65);
    const token = `in:#${longName}`;
    const r = parseSearchQuery(`${token} budget`, NOW);
    expect(r.inChannel).toBeUndefined();
    expect(r.text).toBe(`${token} budget`);
  });

  it('S29 security LOW: from:@<정확히 64자> 는 정상 modifier(경계)', () => {
    const handle = 'z'.repeat(64);
    const r = parseSearchQuery(`from:@${handle} budget`, NOW);
    expect(r.fromHandle).toBe(handle);
    expect(r.text).toBe('budget');
  });

  it('has:link / has:image / has:file 복수 AND', () => {
    const r = parseSearchQuery('report has:file has:image', NOW);
    expect(r.has.sort()).toEqual(['file', 'image']);
    expect(r.text).toBe('report');
  });

  it('has:video(DEFER) 는 텍스트로 degrade', () => {
    const r = parseSearchQuery('clip has:video', NOW);
    expect(r.has).toEqual([]);
    expect(r.text).toBe('clip has:video');
  });

  it('is:pinned 플래그', () => {
    const r = parseSearchQuery('is:pinned announcement', NOW);
    expect(r.isPinned).toBe(true);
    expect(r.text).toBe('announcement');
  });

  it('is:foo 는 텍스트로 degrade', () => {
    const r = parseSearchQuery('is:foo x', NOW);
    expect(r.isPinned).toBe(false);
    expect(r.text).toBe('is:foo x');
  });

  it('before:YYYY-MM-DD → until = 그 날 자정(미포함)', () => {
    const r = parseSearchQuery('before:2025-02-01', NOW);
    expect(r.until?.toISOString()).toBe('2025-02-01T00:00:00.000Z');
    expect(r.since).toBeUndefined();
  });

  it('after:YYYY-MM-DD → since = 다음 날 자정(그 날 미포함)', () => {
    const r = parseSearchQuery('after:2025-01-31', NOW);
    expect(r.since?.toISOString()).toBe('2025-02-01T00:00:00.000Z');
  });

  it('잘못된 날짜는 텍스트로 degrade', () => {
    const r = parseSearchQuery('before:2025-13-40 hi', NOW);
    expect(r.until).toBeUndefined();
    expect(r.text).toBe('before:2025-13-40 hi');
  });

  it('during:today → 오늘 00:00 ~ 내일 00:00', () => {
    const r = parseSearchQuery('during:today', NOW);
    expect(r.since?.toISOString()).toBe('2025-01-15T00:00:00.000Z');
    expect(r.until?.toISOString()).toBe('2025-01-16T00:00:00.000Z');
  });

  it('during:yesterday', () => {
    const r = parseSearchQuery('during:yesterday', NOW);
    expect(r.since?.toISOString()).toBe('2025-01-14T00:00:00.000Z');
    expect(r.until?.toISOString()).toBe('2025-01-15T00:00:00.000Z');
  });

  it('during:YYYY-MM → 해당 월 전체', () => {
    const r = parseSearchQuery('during:2024-12', NOW);
    expect(r.since?.toISOString()).toBe('2024-12-01T00:00:00.000Z');
    expect(r.until?.toISOString()).toBe('2025-01-01T00:00:00.000Z');
  });

  it('복합 AND: from + in + has + is + 텍스트', () => {
    const r = parseSearchQuery('from:@bob in:#ops has:link is:pinned outage', NOW);
    expect(r.fromHandle).toBe('bob');
    expect(r.inChannel).toBe('ops');
    expect(r.has).toEqual(['link']);
    expect(r.isPinned).toBe(true);
    expect(r.text).toBe('outage');
  });

  it('알 수 없는 modifier 는 텍스트로', () => {
    const r = parseSearchQuery('foo:bar baz', NOW);
    expect(r.text).toBe('foo:bar baz');
  });

  it('값 없는 modifier(from:)는 텍스트로 degrade', () => {
    const r = parseSearchQuery('from: hi', NOW);
    expect(r.fromHandle).toBeUndefined();
    expect(r.text).toBe('from: hi');
  });

  it('@ 없는 from:alice 도 핸들로 인식', () => {
    const r = parseSearchQuery('from:alice', NOW);
    expect(r.fromHandle).toBe('alice');
  });
});
