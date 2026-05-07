import { describe, it, expect } from 'vitest';
import { gateEveryoneMention, gateHereMention } from '../../../src/messages/mentions/gate';
import type { Mentions } from '../../../src/messages/mentions/mention-extractor';

const BASE: Mentions = { users: ['u1'], channels: ['c1'], everyone: true, here: false };

describe('gateEveryoneMention (task-044-iter3)', () => {
  it('OWNER 는 everyone=true 유지', () => {
    expect(gateEveryoneMention(BASE, 'OWNER')).toEqual(BASE);
  });

  it('ADMIN 도 everyone=true 유지', () => {
    expect(gateEveryoneMention(BASE, 'ADMIN')).toEqual(BASE);
  });

  it('MEMBER 가 입력한 everyone=true 는 silently false 로 다운그레이드', () => {
    const out = gateEveryoneMention(BASE, 'MEMBER');
    expect(out.everyone).toBe(false);
    // users / channels 는 그대로 유지 — everyone 만 영향
    expect(out.users).toEqual(BASE.users);
    expect(out.channels).toEqual(BASE.channels);
  });

  it('이미 false 면 어떤 role 이든 그대로', () => {
    const m: Mentions = { users: [], channels: [], everyone: false, here: false };
    expect(gateEveryoneMention(m, 'MEMBER')).toEqual(m);
    expect(gateEveryoneMention(m, 'OWNER')).toEqual(m);
  });

  it('input mutation 안 함 — 새 객체 반환', () => {
    const input: Mentions = { users: [], channels: [], everyone: true, here: false };
    const out = gateEveryoneMention(input, 'MEMBER');
    expect(input.everyone).toBe(true); // 원본 변경되지 않음
    expect(out).not.toBe(input);
  });
});

/**
 * task-046 iter8 (A9): @here 게이트 — @everyone 과 동일한 정책.
 */
describe('gateHereMention (task-046 iter8 A9)', () => {
  const HERE_BASE: Mentions = { users: ['u1'], channels: [], everyone: false, here: true };

  it('OWNER / ADMIN 는 here=true 유지', () => {
    expect(gateHereMention(HERE_BASE, 'OWNER').here).toBe(true);
    expect(gateHereMention(HERE_BASE, 'ADMIN').here).toBe(true);
  });

  it('MEMBER 가 입력한 here=true 는 silently false', () => {
    const out = gateHereMention(HERE_BASE, 'MEMBER');
    expect(out.here).toBe(false);
    expect(out.users).toEqual(['u1']); // users 영향 없음
  });

  it('이미 here=false 면 그대로', () => {
    const m: Mentions = { users: [], channels: [], everyone: false, here: false };
    expect(gateHereMention(m, 'MEMBER')).toEqual(m);
  });
});
