import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseDndDuration,
  parseStatusArgs,
  transformInChannel,
} from '../../../src/slash-commands/slash-transforms';

/**
 * S80 (D15 / FR-SC-04·05) — 슬래시 텍스트 변환 + 기간/상태 파싱 단위 테스트.
 */
describe('transformInChannel (FR-SC-04)', () => {
  it('/shrug 는 본문 뒤에 sigil 을 붙인다', () => {
    expect(transformInChannel('shrug', '안녕')).toBe('안녕 ¯\\_(ツ)_/¯');
  });

  it('/shrug 본문이 비면 sigil 만 보낸다', () => {
    expect(transformInChannel('shrug', '   ')).toBe('¯\\_(ツ)_/¯');
  });

  it('/tableflip 과 /unflip 도 sigil 을 붙인다', () => {
    expect(transformInChannel('tableflip', '화남')).toBe('화남 (╯°□°）╯︵ ┻━┻');
    expect(transformInChannel('unflip', '')).toBe('┬─┬ ノ( ゜-゜ノ)');
  });

  it('/me 는 본문을 이탤릭 마크로 감싼다(FR-RC18)', () => {
    expect(transformInChannel('me', 'waves')).toBe('_waves_');
  });

  it('/me 본문이 비면 null(변환 불가)', () => {
    expect(transformInChannel('me', '  ')).toBeNull();
  });

  it('변환 대상이 아닌 커맨드는 null', () => {
    expect(transformInChannel('away', 'x')).toBeNull();
  });
});

describe('parseDndDuration (FR-SC-05)', () => {
  const now = new Date('2025-01-01T12:00:00Z');
  beforeEach(() => vi.setSystemTime(now));
  afterEach(() => vi.useRealTimers());

  it('인자 없음 → 무기한', () => {
    expect(parseDndDuration('', now)).toEqual({ kind: 'indefinite' });
  });

  it('30m → now + 30분', () => {
    const r = parseDndDuration('30m', now);
    expect(r.kind).toBe('until');
    if (r.kind === 'until') expect(r.until.toISOString()).toBe('2025-01-01T12:30:00.000Z');
  });

  it('1h / 2h → 시간 단위', () => {
    const r1 = parseDndDuration('1h', now);
    const r2 = parseDndDuration('2 hours', now);
    if (r1.kind === 'until') expect(r1.until.toISOString()).toBe('2025-01-01T13:00:00.000Z');
    if (r2.kind === 'until') expect(r2.until.toISOString()).toBe('2025-01-01T14:00:00.000Z');
  });

  it('tonight → 오늘 23:59:59(미래)', () => {
    const r = parseDndDuration('tonight', now);
    expect(r.kind).toBe('until');
    if (r.kind === 'until') {
      expect(r.until.getTime()).toBeGreaterThan(now.getTime());
      expect(r.until.toISOString()).toBe('2025-01-01T23:59:59.000Z');
    }
  });

  it('알 수 없는 토큰 → invalid', () => {
    expect(parseDndDuration('forever', now)).toEqual({ kind: 'invalid' });
    expect(parseDndDuration('0m', now)).toEqual({ kind: 'invalid' });
  });
});

describe('parseStatusArgs (FR-SC-05)', () => {
  it('선두 :shortcode: 를 emoji 로 분리한다', () => {
    expect(parseStatusArgs(':coffee: 휴식 중')).toEqual({ emoji: ':coffee:', text: '휴식 중' });
  });

  it('이모지만 있으면 text=null', () => {
    expect(parseStatusArgs(':wave:')).toEqual({ emoji: ':wave:', text: null });
  });

  it('이모지 없으면 전체가 text', () => {
    expect(parseStatusArgs('점심 식사')).toEqual({ emoji: null, text: '점심 식사' });
  });

  it('빈 인자 → 둘 다 null(클리어)', () => {
    expect(parseStatusArgs('   ')).toEqual({ emoji: null, text: null });
  });
});
