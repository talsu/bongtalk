import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EVERYONE_CONFIRM_THRESHOLD, BULK_MENTION_CONFIRM_THRESHOLD } from '@qufox/shared-types';
import {
  canUseSpecialMention,
  firstUnauthorizedSpecialMention,
  specialMentionItems,
  needsSpecialMentionConfirm,
  type SpecialMentionKey,
} from './specialMention';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('canUseSpecialMention (FR-MSG-15 · S94 Option B) — 서버 게이트 정합', () => {
  it('allows @everyone only for OWNER/ADMIN/MODERATOR (MENTION_EVERYONE base)', () => {
    expect(canUseSpecialMention('everyone', 'OWNER')).toBe(true);
    expect(canUseSpecialMention('everyone', 'ADMIN')).toBe(true);
    expect(canUseSpecialMention('everyone', 'MODERATOR')).toBe(true);
    expect(canUseSpecialMention('everyone', 'MEMBER')).toBe(false);
    expect(canUseSpecialMention('everyone', 'GUEST')).toBe(false);
  });

  // S94 (067, Option B): @here/@channel 는 MENTION_CHANNEL(기본 MEMBER 허용)이라
  // GUEST 를 제외한 전 역할이 사용 가능(서버 gateHere/ChannelMention 정합).
  it('allows @here / @channel for everyone except GUEST (MENTION_CHANNEL base)', () => {
    for (const key of ['here', 'channel'] as const) {
      expect(canUseSpecialMention(key, 'OWNER')).toBe(true);
      expect(canUseSpecialMention(key, 'ADMIN')).toBe(true);
      expect(canUseSpecialMention(key, 'MODERATOR')).toBe(true);
      expect(canUseSpecialMention(key, 'MEMBER')).toBe(true);
      expect(canUseSpecialMention(key, 'GUEST')).toBe(false);
    }
  });
});

describe('specialMentionItems (FR-RC03 · S94) — 팝업 상단 특수항목', () => {
  // S94 (067, Option B): MEMBER 도 @here/@channel 을 기본 사용할 수 있어 특수항목에
  // 노출된다(@everyone 만 권한 없음). 종전 "MEMBER 특수항목 없음" 회귀를 복원.
  it('shows @here and @channel (not @everyone) for a MEMBER', () => {
    const keys = specialMentionItems('MEMBER', '').map((i) => i.key);
    expect(keys).toEqual<SpecialMentionKey[]>(['here', 'channel']);
  });

  it('shows no special items for a GUEST', () => {
    const keys = specialMentionItems('GUEST', '').map((i) => i.key);
    expect(keys).toEqual<SpecialMentionKey[]>([]);
  });

  it('includes @channel for permitted roles (S94 복원)', () => {
    for (const role of ['OWNER', 'ADMIN', 'MEMBER'] as const) {
      const keys = specialMentionItems(role, '').map((i) => i.key as string);
      expect(keys).toContain('channel');
    }
  });

  it('includes @here, @channel, @everyone for an ADMIN', () => {
    const keys = specialMentionItems('ADMIN', '').map((i) => i.key);
    expect(keys).toContain('here');
    expect(keys).toContain('channel');
    expect(keys).toContain('everyone');
  });

  it('filters special items by the typed prefix', () => {
    const keys = specialMentionItems('OWNER', 'ever').map((i) => i.key);
    expect(keys).toEqual<SpecialMentionKey[]>(['everyone']);
  });

  it('shows all permitted items (here → channel → everyone) for an empty query', () => {
    const keys = specialMentionItems('OWNER', '').map((i) => i.key);
    expect(keys).toEqual<SpecialMentionKey[]>(['here', 'channel', 'everyone']);
  });
});

describe('needsSpecialMentionConfirm (FR-MSG-14) — 임계값 confirm', () => {
  it('requires confirm for @everyone at or above EVERYONE_CONFIRM_THRESHOLD', () => {
    expect(needsSpecialMentionConfirm('everyone', EVERYONE_CONFIRM_THRESHOLD - 1)).toBe(false);
    expect(needsSpecialMentionConfirm('everyone', EVERYONE_CONFIRM_THRESHOLD)).toBe(true);
  });

  it('requires confirm for @here / @channel at or above BULK_MENTION_CONFIRM_THRESHOLD', () => {
    for (const key of ['here', 'channel'] as const) {
      expect(needsSpecialMentionConfirm(key, BULK_MENTION_CONFIRM_THRESHOLD - 1)).toBe(false);
      expect(needsSpecialMentionConfirm(key, BULK_MENTION_CONFIRM_THRESHOLD)).toBe(true);
    }
  });

  it('uses the lower @everyone threshold, not the bulk one', () => {
    // 6 members → @everyone confirms, but @here does not yet.
    expect(needsSpecialMentionConfirm('everyone', 6)).toBe(true);
    expect(needsSpecialMentionConfirm('here', 6)).toBe(false);
  });
});

describe('firstUnauthorizedSpecialMention (S44 FR-MN-16 · S94) — 경고 토스트 트리거', () => {
  it('MEMBER 가 @everyone 입력 시 everyone 반환(권한 없음)', () => {
    expect(firstUnauthorizedSpecialMention('hey @everyone look', 'MEMBER')).toBe('everyone');
  });

  // S94 (067, Option B): @here/@channel 는 MEMBER 기본 허용이라 더 이상 경고하지 않는다.
  it('MEMBER 가 @here / @channel 입력 시 null(기본 허용 — 경고 없음)', () => {
    expect(firstUnauthorizedSpecialMention('@here standup', 'MEMBER')).toBeNull();
    expect(firstUnauthorizedSpecialMention('@channel heads up', 'MEMBER')).toBeNull();
  });

  // GUEST 는 @here/@channel 도 권한이 없어 경고한다(MENTION_CHANNEL base off).
  it('GUEST 가 @here / @channel 입력 시 해당 키 반환(권한 없음)', () => {
    expect(firstUnauthorizedSpecialMention('@here standup', 'GUEST')).toBe('here');
    expect(firstUnauthorizedSpecialMention('@channel heads up', 'GUEST')).toBe('channel');
  });

  it('OWNER / ADMIN 은 권한이 있어 null(경고 없음)', () => {
    expect(firstUnauthorizedSpecialMention('@everyone @here @channel', 'OWNER')).toBeNull();
    expect(firstUnauthorizedSpecialMention('@everyone @here @channel', 'ADMIN')).toBeNull();
  });

  it('특수멘션이 없으면 null', () => {
    expect(firstUnauthorizedSpecialMention('plain text @alice', 'MEMBER')).toBeNull();
  });

  it('@everyone 과 @here 가 둘 다 있으면 everyone 을 먼저 반환(우선순위)', () => {
    expect(firstUnauthorizedSpecialMention('@here and @everyone', 'MEMBER')).toBe('everyone');
  });

  it('이메일/단어 경계 오탐 방지 — foo@everyone 은 미매칭', () => {
    expect(firstUnauthorizedSpecialMention('foo@everyone', 'MEMBER')).toBeNull();
  });
});
