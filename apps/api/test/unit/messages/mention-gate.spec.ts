import { describe, it, expect } from 'vitest';
import {
  gateChannelMention,
  gateEveryoneMention,
  gateHereMention,
} from '../../../src/messages/mentions/gate';
import type { Mentions } from '../../../src/messages/mentions/mention-extractor';

const BASE: Mentions = {
  users: ['u1'],
  channels: ['c1'],
  everyone: true,
  here: false,
  channel: false,
};

/**
 * S44 (FR-MN-02 / FR-MN-16): 게이트 시그니처가 role enum 에서 boolean
 * `hasMentionEveryone` 으로 바뀌었다. 권한 산정(역할 기본값 + 채널 override
 * 5단계 fold)은 ChannelAccessService.resolveMentionEveryone 이 수행하고, gate 는
 * 그 boolean 결과만 적용하는 순수 후처리 함수다.
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
    const m: Mentions = { users: [], channels: [], everyone: false, here: false, channel: false };
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
    };
    const out = gateEveryoneMention(input, false);
    expect(input.everyone).toBe(true); // 원본 변경되지 않음
    expect(out).not.toBe(input);
  });
});

describe('gateHereMention (S44 boolean gate)', () => {
  const HERE_BASE: Mentions = {
    users: ['u1'],
    channels: [],
    everyone: false,
    here: true,
    channel: false,
  };

  it('권한 있으면 here=true 유지', () => {
    expect(gateHereMention(HERE_BASE, true).here).toBe(true);
  });

  it('권한 없으면 here=true 는 silently false', () => {
    const out = gateHereMention(HERE_BASE, false);
    expect(out.here).toBe(false);
    expect(out.users).toEqual(['u1']); // users 영향 없음
  });

  it('이미 here=false 면 그대로', () => {
    const m: Mentions = { users: [], channels: [], everyone: false, here: false, channel: false };
    expect(gateHereMention(m, false)).toEqual(m);
  });
});

describe('gateChannelMention (S44 boolean gate)', () => {
  const CH_BASE: Mentions = {
    users: ['u1'],
    channels: [],
    everyone: false,
    here: false,
    channel: true,
  };

  it('권한 있으면 channel=true 유지', () => {
    expect(gateChannelMention(CH_BASE, true).channel).toBe(true);
  });

  it('권한 없으면 channel=true 는 silently false', () => {
    const out = gateChannelMention(CH_BASE, false);
    expect(out.channel).toBe(false);
    expect(out.users).toEqual(['u1']); // users 영향 없음
  });

  it('이미 channel=false 면 그대로', () => {
    const m: Mentions = { users: [], channels: [], everyone: false, here: false, channel: false };
    expect(gateChannelMention(m, false)).toEqual(m);
  });
});
