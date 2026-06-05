import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseReminder } from '../../../src/slash-commands/reminder-parse';

/**
 * S80 (D15 / FR-SC-06) — /remind 자연어 파싱 단위 테스트(chrono-node + 한국어 보조).
 *
 * chrono 의 상대 표현은 기준 시각(now)에 고정한다 — vi.setSystemTime + parseReminder(.., now)
 * 로 결정성을 보장한다.
 */
describe('parseReminder (FR-SC-06)', () => {
  // 2025-01-01 은 수요일. 영어/한국어 표현을 이 기준 시각에 고정 평가한다.
  const now = new Date('2025-01-01T00:00:00Z');
  beforeEach(() => vi.setSystemTime(now));
  afterEach(() => vi.useRealTimers());

  it('영어: `in 30 minutes 회의 준비` → +30분', () => {
    const r = parseReminder('in 30 minutes 회의 준비', now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.scheduledAt.getTime()).toBe(now.getTime() + 30 * 60_000);
      expect(r.message).toBe('회의 준비');
    }
  });

  it('영어: `tomorrow 10am 약 먹기` → 다음날 미래 시각', () => {
    const r = parseReminder('tomorrow 10am 약 먹기', now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.scheduledAt.getTime()).toBeGreaterThan(now.getTime());
      expect(r.message).toBe('약 먹기');
    }
  });

  it('Slack 스타일 `me to` 접두를 제거한다', () => {
    const r = parseReminder('me to in 1 hour 스탠드업', now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.scheduledAt.getTime()).toBe(now.getTime() + 60 * 60_000);
      expect(r.message).toBe('스탠드업');
    }
  });

  it('따옴표 메시지 + 뒤 시각표현', () => {
    const r = parseReminder('"운동하기" in 2 hours', now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.scheduledAt.getTime()).toBe(now.getTime() + 2 * 60 * 60_000);
      expect(r.message).toBe('운동하기');
    }
  });

  it('한국어 보조: `30분 후 물 마시기`', () => {
    const r = parseReminder('30분 후 물 마시기', now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.scheduledAt.getTime()).toBe(now.getTime() + 30 * 60_000);
      expect(r.message).toBe('물 마시기');
    }
  });

  it('한국어 보조: `2시간 후 미팅`', () => {
    const r = parseReminder('2시간 후 미팅', now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.scheduledAt.getTime()).toBe(now.getTime() + 2 * 60 * 60_000);
      expect(r.message).toBe('미팅');
    }
  });

  it('한국어 보조: `내일 9시 운동` → 다음날 09:00', () => {
    const r = parseReminder('내일 9시 운동', now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.scheduledAt.toISOString()).toBe('2025-01-02T09:00:00.000Z');
      expect(r.message).toBe('운동');
    }
  });

  it('시각표현만 있고 메시지가 없으면 실패', () => {
    expect(parseReminder('in 30 minutes', now).ok).toBe(false);
  });

  it('과거 시각은 실패', () => {
    expect(parseReminder('yesterday 회의', now).ok).toBe(false);
  });

  it('인식 불가 입력은 실패', () => {
    expect(parseReminder('asdf qwer zxcv', now).ok).toBe(false);
    expect(parseReminder('', now).ok).toBe(false);
  });
});
