import { describe, it, expect } from 'vitest';
import {
  detectActiveModifierToken,
  HAS_STATIC_OPTIONS,
  completeModifierToken,
} from './suggestToken';

/**
 * S31 (FR-S02): 입력 중 현재 토큰이 from:/in:/has: 수식어인지 감지하고, 값
 * prefix 를 추출하는 순수 함수.
 *
 * S31 (reviewer MAJOR2): caret 위치는 보지 않는다 — `lastIndexOf(' ')` 로
 * 입력의 *마지막 토큰* 만 본다(커서가 중간 토큰에 있어도 마지막 토큰을 활성으로
 * 취급). 실제 caret(selectionStart) 기준 토큰 처리(중간 토큰 편집 자동완성)는
 * carryover 로 남긴다. 본 함수/스펙은 "마지막 토큰 한정" 동작만 보장한다.
 */
describe('detectActiveModifierToken (S31 FR-S02)', () => {
  it('from:al — kind=user, prefix=al', () => {
    const t = detectActiveModifierToken('from:al');
    expect(t).toEqual({ key: 'from', kind: 'user', prefix: 'al', start: 0 });
  });

  it('in:gen — kind=channel, prefix=gen', () => {
    const t = detectActiveModifierToken('in:gen');
    expect(t).toEqual({ key: 'in', kind: 'channel', prefix: 'gen', start: 0 });
  });

  it('has:im — kind=has(정적 옵션), prefix=im', () => {
    const t = detectActiveModifierToken('has:im');
    expect(t).toEqual({ key: 'has', kind: 'has', prefix: 'im', start: 0 });
  });

  it('@ / # 접두 제거된 prefix 반환', () => {
    expect(detectActiveModifierToken('from:@al')?.prefix).toBe('al');
    expect(detectActiveModifierToken('in:#gen')?.prefix).toBe('gen');
  });

  it('값이 없는 from: 도 prefix 빈 문자열로 활성(드롭다운 즉시 노출)', () => {
    expect(detectActiveModifierToken('from:')).toEqual({
      key: 'from',
      kind: 'user',
      prefix: '',
      start: 0,
    });
  });

  it('이전 토큰이 완성되고 마지막 토큰만 활성으로 본다', () => {
    const input = 'hello from:al';
    const t = detectActiveModifierToken(input);
    expect(t).toEqual({ key: 'from', kind: 'user', prefix: 'al', start: 6 });
  });

  it('마지막 토큰이 수식어가 아니면 null', () => {
    expect(detectActiveModifierToken('from:alice roadmap')).toBeNull();
    expect(detectActiveModifierToken('hello')).toBeNull();
  });

  it('알 수 없는 키는 null', () => {
    expect(detectActiveModifierToken('before:2025')).toBeNull();
    expect(detectActiveModifierToken('foo:bar')).toBeNull();
  });

  it('빈 입력 / 공백으로 끝나면 활성 토큰 없음', () => {
    expect(detectActiveModifierToken('')).toBeNull();
    expect(detectActiveModifierToken('from:alice ')).toBeNull();
  });
});

describe('completeModifierToken (S31 FR-S02)', () => {
  it('from:al 을 선택 후 from:alice 로 치환 + 트레일링 공백', () => {
    expect(completeModifierToken('from:al', 0, 'from', '@alice')).toBe('from:@alice ');
  });

  it('앞 텍스트 보존: hello from:gen → hello in:#general', () => {
    // start=6 위치의 토큰만 교체.
    expect(completeModifierToken('hello in:gen', 6, 'in', '#general')).toBe('hello in:#general ');
  });

  it('has:im → has:image', () => {
    expect(completeModifierToken('has:im', 0, 'has', 'image')).toBe('has:image ');
  });
});

describe('HAS_STATIC_OPTIONS (S31 FR-S02)', () => {
  it('image/file/link 정적 옵션', () => {
    expect(HAS_STATIC_OPTIONS).toEqual(['image', 'file', 'link']);
  });
});
