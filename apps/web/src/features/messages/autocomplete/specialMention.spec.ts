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

describe('canUseSpecialMention (FR-MSG-15) — 서버 게이트 정합', () => {
  it('allows @everyone only for OWNER/ADMIN', () => {
    expect(canUseSpecialMention('everyone', 'OWNER')).toBe(true);
    expect(canUseSpecialMention('everyone', 'ADMIN')).toBe(true);
    expect(canUseSpecialMention('everyone', 'MEMBER')).toBe(false);
  });

  // S18 리뷰 MAJOR: 서버 gateHereMention 이 MEMBER 의 @here fanout 을 무효화하므로
  // 클라 권한 게이트도 @here 를 OWNER/ADMIN 전용으로 맞춘다(이전엔 MEMBER 허용).
  it('allows @here only for OWNER/ADMIN (matches gateHereMention)', () => {
    expect(canUseSpecialMention('here', 'OWNER')).toBe(true);
    expect(canUseSpecialMention('here', 'ADMIN')).toBe(true);
    expect(canUseSpecialMention('here', 'MEMBER')).toBe(false);
  });
});

describe('specialMentionItems (FR-RC03) — 팝업 상단 특수항목', () => {
  // S18 리뷰 MAJOR: 서버 extractor 가 @channel 을 추출하지 않으므로 특수항목에서
  // 완전히 제거. @here 는 OWNER/ADMIN 전용이라 MEMBER 에게는 특수항목이 없다.
  it('shows no special items for a MEMBER (no @channel, @here/@everyone gated)', () => {
    const keys = specialMentionItems('MEMBER', '').map((i) => i.key);
    expect(keys).toEqual<SpecialMentionKey[]>([]);
  });

  it('never includes @channel for any role', () => {
    for (const role of ['OWNER', 'ADMIN', 'MEMBER'] as const) {
      const keys = specialMentionItems(role, '').map((i) => i.key as string);
      expect(keys).not.toContain('channel');
    }
  });

  it('includes @here and @everyone for an ADMIN', () => {
    const keys = specialMentionItems('ADMIN', '').map((i) => i.key);
    expect(keys).toContain('here');
    expect(keys).toContain('everyone');
  });

  it('filters special items by the typed prefix', () => {
    const keys = specialMentionItems('OWNER', 'ever').map((i) => i.key);
    expect(keys).toEqual<SpecialMentionKey[]>(['everyone']);
  });

  it('shows all permitted items (here → everyone) for an empty query', () => {
    const keys = specialMentionItems('OWNER', '').map((i) => i.key);
    expect(keys).toEqual<SpecialMentionKey[]>(['here', 'everyone']);
  });
});

describe('needsSpecialMentionConfirm (FR-MSG-14) — 임계값 confirm', () => {
  it('requires confirm for @everyone at or above EVERYONE_CONFIRM_THRESHOLD', () => {
    expect(needsSpecialMentionConfirm('everyone', EVERYONE_CONFIRM_THRESHOLD - 1)).toBe(false);
    expect(needsSpecialMentionConfirm('everyone', EVERYONE_CONFIRM_THRESHOLD)).toBe(true);
  });

  it('requires confirm for @here at or above BULK_MENTION_CONFIRM_THRESHOLD', () => {
    expect(needsSpecialMentionConfirm('here', BULK_MENTION_CONFIRM_THRESHOLD - 1)).toBe(false);
    expect(needsSpecialMentionConfirm('here', BULK_MENTION_CONFIRM_THRESHOLD)).toBe(true);
  });

  it('uses the lower @everyone threshold, not the bulk one', () => {
    // 6 members → @everyone confirms, but @here does not yet.
    expect(needsSpecialMentionConfirm('everyone', 6)).toBe(true);
    expect(needsSpecialMentionConfirm('here', 6)).toBe(false);
  });
});

describe('firstUnauthorizedSpecialMention (S44 FR-MN-16) — 경고 토스트 트리거', () => {
  it('MEMBER 가 @everyone 입력 시 everyone 반환(권한 없음)', () => {
    expect(firstUnauthorizedSpecialMention('hey @everyone look', 'MEMBER')).toBe('everyone');
  });

  it('MEMBER 가 @here 입력 시 here 반환', () => {
    expect(firstUnauthorizedSpecialMention('@here standup', 'MEMBER')).toBe('here');
  });

  it('OWNER / ADMIN 은 권한이 있어 null(경고 없음)', () => {
    expect(firstUnauthorizedSpecialMention('@everyone @here', 'OWNER')).toBeNull();
    expect(firstUnauthorizedSpecialMention('@everyone @here', 'ADMIN')).toBeNull();
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
