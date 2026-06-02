import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isMuteActive,
  resolveEffectiveLevel,
  shouldNotifyMention,
  type ResolvedNotifInputs,
} from '../../../src/notifications/notif-level';

/**
 * S46 (D06 / ADR-6 / FR-MN-05/06/07/08): NotifLevel 3계층 resolve + fanout 게이트
 * 순수 함수 단위 검증.
 */
beforeEach(() => {
  vi.setSystemTime('2025-01-01T00:00:00Z');
});

const base: ResolvedNotifInputs = {
  channelLevel: null,
  serverLevel: null,
  globalLevel: null,
  serverMuted: false,
  channelMuted: false,
};

describe('resolveEffectiveLevel — 3계층 우선순위(채널 > 서버 > 글로벌)', () => {
  it('어떤 층도 값이 없으면 MENTIONS 기본값', () => {
    expect(
      resolveEffectiveLevel({ channelLevel: null, serverLevel: null, globalLevel: null }),
    ).toBe('MENTIONS');
  });

  it('글로벌만 ALL 이면 ALL 상속', () => {
    expect(
      resolveEffectiveLevel({ channelLevel: null, serverLevel: null, globalLevel: 'ALL' }),
    ).toBe('ALL');
  });

  it('서버가 글로벌을 오버라이드(서버 NOTHING > 글로벌 ALL)', () => {
    expect(
      resolveEffectiveLevel({ channelLevel: null, serverLevel: 'NOTHING', globalLevel: 'ALL' }),
    ).toBe('NOTHING');
  });

  it('채널이 서버를 오버라이드(채널 ALL > 서버 NOTHING > 글로벌 MENTIONS)', () => {
    expect(
      resolveEffectiveLevel({
        channelLevel: 'ALL',
        serverLevel: 'NOTHING',
        globalLevel: 'MENTIONS',
      }),
    ).toBe('ALL');
  });

  it('채널 level=null 은 서버 상속(서버 ALL 사용)', () => {
    expect(
      resolveEffectiveLevel({ channelLevel: null, serverLevel: 'ALL', globalLevel: 'NOTHING' }),
    ).toBe('ALL');
  });
});

describe('shouldNotifyMention — level 별 direct/broad 게이트', () => {
  it('ALL: direct·broad 모두 통과', () => {
    const inputs = { ...base, globalLevel: 'ALL' as const };
    expect(shouldNotifyMention(inputs, 'direct')).toBe(true);
    expect(shouldNotifyMention(inputs, 'broad')).toBe(true);
  });

  it('MENTIONS: direct 통과·broad 스킵', () => {
    const inputs = { ...base, globalLevel: 'MENTIONS' as const };
    expect(shouldNotifyMention(inputs, 'direct')).toBe(true);
    expect(shouldNotifyMention(inputs, 'broad')).toBe(false);
  });

  it('NOTHING: direct·broad 모두 스킵', () => {
    const inputs = { ...base, globalLevel: 'NOTHING' as const };
    expect(shouldNotifyMention(inputs, 'direct')).toBe(false);
    expect(shouldNotifyMention(inputs, 'broad')).toBe(false);
  });

  it('기본값(모든 층 null) = MENTIONS: direct 통과·broad 스킵', () => {
    expect(shouldNotifyMention(base, 'direct')).toBe(true);
    expect(shouldNotifyMention(base, 'broad')).toBe(false);
  });

  it('채널 오버라이드가 서버/글로벌을 이긴다(채널 NOTHING → direct 도 스킵)', () => {
    const inputs = {
      ...base,
      channelLevel: 'NOTHING' as const,
      serverLevel: 'ALL' as const,
      globalLevel: 'ALL' as const,
    };
    expect(shouldNotifyMention(inputs, 'direct')).toBe(false);
  });

  it('isMuted(서버) 면 level=ALL·direct 라도 스킵', () => {
    const inputs = { ...base, globalLevel: 'ALL' as const, serverMuted: true };
    expect(shouldNotifyMention(inputs, 'direct')).toBe(false);
  });

  it('isMuted(채널) 면 level=ALL·direct 라도 스킵', () => {
    const inputs = { ...base, channelLevel: 'ALL' as const, channelMuted: true };
    expect(shouldNotifyMention(inputs, 'direct')).toBe(false);
  });
});

describe('isMuteActive — muteUntil 만료 판정', () => {
  const now = new Date('2025-01-01T00:00:00Z');

  it('isMuted=false 면 항상 비활성', () => {
    expect(isMuteActive(false, null, now)).toBe(false);
  });

  it('isMuted=true + muteUntil=null(영구) 면 활성', () => {
    expect(isMuteActive(true, null, now)).toBe(true);
  });

  it('isMuted=true + muteUntil 미래 면 활성', () => {
    expect(isMuteActive(true, new Date('2025-01-01T01:00:00Z'), now)).toBe(true);
  });

  it('isMuted=true + muteUntil 과거 면 비활성(만료)', () => {
    expect(isMuteActive(true, new Date('2024-12-31T23:00:00Z'), now)).toBe(false);
  });
});
