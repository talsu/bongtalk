import { describe, it, expect } from 'vitest';
import { gateEveryoneMention } from '../../../src/messages/mentions/gate';
import type { Mentions } from '../../../src/messages/mentions/mention-extractor';

const BASE: Mentions = { users: ['u1'], channels: ['c1'], everyone: true };

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
    const m: Mentions = { users: [], channels: [], everyone: false };
    expect(gateEveryoneMention(m, 'MEMBER')).toEqual(m);
    expect(gateEveryoneMention(m, 'OWNER')).toEqual(m);
  });

  it('input mutation 안 함 — 새 객체 반환', () => {
    const input: Mentions = { users: [], channels: [], everyone: true };
    const out = gateEveryoneMention(input, 'MEMBER');
    expect(input.everyone).toBe(true); // 원본 변경되지 않음
    expect(out).not.toBe(input);
  });
});
