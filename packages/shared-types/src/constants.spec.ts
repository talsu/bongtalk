import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  EVERYONE_CONFIRM_THRESHOLD,
  BULK_MENTION_CONFIRM_THRESHOLD,
  PRESENCE_IDLE_TIMEOUT,
  TYPING_TTL,
  TYPING_MAX_VISIBLE,
  TYPING_THROTTLE,
  TYPING_FANOUT_RATE_LIMIT,
  TYPING_BATCH_INTERVAL,
  GAP_FETCH_MAX_PAGES,
  UNREAD_LOCK_TTL,
  SEQ_HOLE_TIMEOUT_MS,
  MAX_JOINED_CHANNELS,
  SHARED_CONSTANTS,
} from './constants';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('shared constants (ADR-8)', () => {
  it('matches the canonical ADR-8 values', () => {
    expect(EVERYONE_CONFIRM_THRESHOLD).toBe(6);
    expect(BULK_MENTION_CONFIRM_THRESHOLD).toBe(50);
    expect(PRESENCE_IDLE_TIMEOUT).toBe(600);
    expect(TYPING_TTL).toBe(10);
    // S32 (FR-RT-08): 클라 스로틀 3초, 채널 fanout 초당 10회, batch 주기 2s.
    expect(TYPING_THROTTLE).toBe(3);
    expect(TYPING_FANOUT_RATE_LIMIT).toBe(10);
    expect(TYPING_BATCH_INTERVAL).toBe(2000);
    expect(GAP_FETCH_MAX_PAGES).toBe(10);
    expect(UNREAD_LOCK_TTL).toBe(30000);
    expect(SEQ_HOLE_TIMEOUT_MS).toBe(500);
  });

  it('SHARED_CONSTANTS mirrors the individual exports', () => {
    expect(SHARED_CONSTANTS.EVERYONE_CONFIRM_THRESHOLD).toBe(EVERYONE_CONFIRM_THRESHOLD);
    expect(SHARED_CONSTANTS.UNREAD_LOCK_TTL).toBe(UNREAD_LOCK_TTL);
    expect(SHARED_CONSTANTS.GAP_FETCH_MAX_PAGES).toBe(GAP_FETCH_MAX_PAGES);
    // FIX #6 (S10 review): S07 추가분 MAX_JOINED_CHANNELS 가 단일 객체에도
    // 노출되는지 회귀 가드.
    expect(SHARED_CONSTANTS.MAX_JOINED_CHANNELS).toBe(MAX_JOINED_CHANNELS);
    // S32 (FR-RT-08): 신규 타이핑 상수가 단일 객체에도 노출되는지 회귀 가드.
    expect(SHARED_CONSTANTS.TYPING_THROTTLE).toBe(TYPING_THROTTLE);
    expect(SHARED_CONSTANTS.TYPING_FANOUT_RATE_LIMIT).toBe(TYPING_FANOUT_RATE_LIMIT);
    // S32 (contract #4): TYPING_MAX_VISIBLE 도 단일 객체에 노출돼야 한다 —
    // events.ts 의 typing 스키마 상한(.max)이 이 상수를 단일 출처로 참조하므로
    // 누락되면 와이어 cap 가드가 깨진다.
    expect(SHARED_CONSTANTS.TYPING_MAX_VISIBLE).toBe(TYPING_MAX_VISIBLE);
  });
});
