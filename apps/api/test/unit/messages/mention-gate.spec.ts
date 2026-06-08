import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  gateChannelMention,
  gateEveryoneMention,
  gateHereMention,
  gateRoleMention,
} from '../../../src/messages/mentions/gate';
import type { Mentions } from '../../../src/messages/mentions/mention-extractor';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

const BASE: Mentions = {
  users: ['u1'],
  channels: ['c1'],
  everyone: true,
  here: false,
  channel: false,
  roles: [],
};

/**
 * S44 (FR-MN-02 / FR-MN-16) · S94 (067 / FR-MSG-14): 게이트 시그니처가 role enum
 * 에서 boolean 으로 바뀌었고(S44), S94 에서 @everyone 과 @here/@channel 의 권한
 * 비트가 분리됐다(Option B). gateEveryoneMention 은 hasMentionEveryone(MENTION_EVERYONE,
 * OWNER/ADMIN 전용), gateHere/ChannelMention 은 hasMentionChannel(MENTION_CHANNEL,
 * 기본 MEMBER 허용)을 받는다. 권한 산정은 ChannelAccessService.resolveMentionScopes 가
 * 수행하고, gate 는 그 boolean 결과만 적용하는 순수 후처리 함수다.
 */
describe('gateEveryoneMention (S44 boolean gate)', () => {
  it('권한 있으면(true) everyone=true 유지', () => {
    expect(gateEveryoneMention(BASE, true)).toEqual(BASE);
  });

  it('권한 없으면(false) everyone=true 는 silently false 로 다운그레이드', () => {
    const out = gateEveryoneMention(BASE, false);
    expect(out.everyone).toBe(false);
    // users / channels 는 그대로 유지 — everyone 만 영향
    expect(out.users).toEqual(BASE.users);
    expect(out.channels).toEqual(BASE.channels);
  });

  it('이미 false 면 권한 유무와 무관하게 그대로', () => {
    const m: Mentions = {
      users: [],
      channels: [],
      everyone: false,
      here: false,
      channel: false,
      roles: [],
    };
    expect(gateEveryoneMention(m, false)).toEqual(m);
    expect(gateEveryoneMention(m, true)).toEqual(m);
  });

  it('input mutation 안 함 — 새 객체 반환', () => {
    const input: Mentions = {
      users: [],
      channels: [],
      everyone: true,
      here: false,
      channel: false,
      roles: [],
    };
    const out = gateEveryoneMention(input, false);
    expect(input.everyone).toBe(true); // 원본 변경되지 않음
    expect(out).not.toBe(input);
  });
});

describe('gateHereMention (S94 hasMentionChannel gate)', () => {
  const HERE_BASE: Mentions = {
    users: ['u1'],
    channels: [],
    everyone: false,
    here: true,
    channel: false,
    roles: [],
  };

  it('hasMentionChannel=true(=MEMBER 기본 허용)면 here=true 유지', () => {
    expect(gateHereMention(HERE_BASE, true).here).toBe(true);
  });

  it('hasMentionChannel=false 면 here=true 는 silently false', () => {
    const out = gateHereMention(HERE_BASE, false);
    expect(out.here).toBe(false);
    expect(out.users).toEqual(['u1']); // users 영향 없음
  });

  it('이미 here=false 면 그대로', () => {
    const m: Mentions = {
      users: [],
      channels: [],
      everyone: false,
      here: false,
      channel: false,
      roles: [],
    };
    expect(gateHereMention(m, false)).toEqual(m);
  });
});

describe('gateChannelMention (S94 hasMentionChannel gate)', () => {
  const CH_BASE: Mentions = {
    users: ['u1'],
    channels: [],
    everyone: false,
    here: false,
    channel: true,
    roles: [],
  };

  it('hasMentionChannel=true(=MEMBER 기본 허용)면 channel=true 유지', () => {
    expect(gateChannelMention(CH_BASE, true).channel).toBe(true);
  });

  it('hasMentionChannel=false 면 channel=true 는 silently false', () => {
    const out = gateChannelMention(CH_BASE, false);
    expect(out.channel).toBe(false);
    expect(out.users).toEqual(['u1']); // users 영향 없음
  });

  it('이미 channel=false 면 그대로', () => {
    const m: Mentions = {
      users: [],
      channels: [],
      everyone: false,
      here: false,
      channel: false,
      roles: [],
    };
    expect(gateChannelMention(m, false)).toEqual(m);
  });
});

/**
 * S94 (067 / FR-MSG-14 / Option B): @everyone 과 @here/@channel 의 권한 비트 분리 검증.
 * messages.service 가 두 gate 를 합성하는 순서대로(gateChannel(gateHere(gateEveryone))),
 * hasMentionEveryone 과 hasMentionChannel 두 boolean 을 각각 적용한다.
 */
describe('combined broad gate (S94 권한 비트 분리)', () => {
  const ALL_THREE: Mentions = {
    users: ['u1'],
    channels: [],
    everyone: true,
    here: true,
    channel: true,
    roles: [],
  };

  const applyBroadGate = (
    m: Mentions,
    hasMentionEveryone: boolean,
    hasMentionChannel: boolean,
  ): Mentions =>
    gateChannelMention(
      gateHereMention(gateEveryoneMention(m, hasMentionEveryone), hasMentionChannel),
      hasMentionChannel,
    );

  it('MEMBER 기본(everyone=false, channel=true): @everyone strip, @here/@channel 통과', () => {
    const out = applyBroadGate(ALL_THREE, false, true);
    expect(out.everyone).toBe(false);
    expect(out.here).toBe(true);
    expect(out.channel).toBe(true);
  });

  it('둘 다 권한 있으면(OWNER/ADMIN) 전부 통과', () => {
    const out = applyBroadGate(ALL_THREE, true, true);
    expect(out.everyone).toBe(true);
    expect(out.here).toBe(true);
    expect(out.channel).toBe(true);
  });

  it('둘 다 false(GUEST 또는 override 전부 박탈)면 전부 strip', () => {
    const out = applyBroadGate(ALL_THREE, false, false);
    expect(out.everyone).toBe(false);
    expect(out.here).toBe(false);
    expect(out.channel).toBe(false);
  });

  it('@channel 만 deny(hasMentionChannel=false)면 @here/@channel strip, @everyone 은 권한대로', () => {
    const out = applyBroadGate(ALL_THREE, true, false);
    expect(out.everyone).toBe(true);
    expect(out.here).toBe(false);
    expect(out.channel).toBe(false);
  });
});

// S88a (FR-MN-03 / D3): 역할 멘션 게이트는 service 가 산정한 허용 roleId 집합으로
// mentions.roles 를 필터하는 순수 함수다(prisma/권한 의존 없음).
describe('gateRoleMention (S88a / FR-MN-03)', () => {
  const withRoles = (roles: string[]): Mentions => ({
    users: ['u1'],
    channels: [],
    everyone: false,
    here: false,
    channel: false,
    roles,
  });

  it('roles 가 비어 있으면 그대로 반환(no-op)', () => {
    const m = withRoles([]);
    expect(gateRoleMention(m, new Set(['r1']))).toBe(m);
  });

  it('허용 집합에 없는 역할은 silently 제거(다운그레이드)', () => {
    const m = withRoles(['r1', 'r2', 'r3']);
    const out = gateRoleMention(m, new Set(['r1', 'r3']));
    expect(out.roles).toEqual(['r1', 'r3']);
    // users 등 다른 필드는 영향 없음.
    expect(out.users).toEqual(['u1']);
  });

  it('전부 허용이면 동일 객체를 반환(불필요한 할당 회피)', () => {
    const m = withRoles(['r1', 'r2']);
    expect(gateRoleMention(m, new Set(['r1', 'r2']))).toBe(m);
  });

  it('전부 비허용이면 roles=[] 로 다운그레이드', () => {
    const m = withRoles(['r1', 'r2']);
    const out = gateRoleMention(m, new Set<string>());
    expect(out.roles).toEqual([]);
    expect(out).not.toBe(m); // 새 객체 반환
  });
});
