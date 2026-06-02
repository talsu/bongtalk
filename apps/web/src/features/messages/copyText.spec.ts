import { describe, expect, it } from 'vitest';
import type { MessageDto } from '@qufox/shared-types';
import { resolveCopyPlainText } from './copyText';

/**
 * S37 (FR-MSG-17): "메시지 복사" 정본 텍스트 우선순위 단위 테스트.
 * contentPlain → content → ''.
 */
function makeMsg(over: Partial<MessageDto> & Record<string, unknown>): MessageDto {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    channelId: '22222222-2222-4222-8222-222222222222',
    authorId: '33333333-3333-4333-8333-333333333333',
    content: null,
    contentRaw: null,
    contentAst: null,
    contentPlain: null,
    type: 'DEFAULT',
    mentions: { users: [], channels: [], everyone: false, here: false, channel: false },
    edited: false,
    deleted: false,
    createdAt: '2025-01-01T00:00:00.000Z',
    editedAt: null,
    reactions: [],
    parentMessageId: null,
    thread: null,
    attachments: [],
    pinnedAt: null,
    pinnedBy: null,
    version: 0,
    isBroadcast: false,
    parentExcerpt: null,
    ...over,
  } as MessageDto;
}

describe('resolveCopyPlainText (FR-MSG-17)', () => {
  it('contentPlain 이 있으면 평문 정본을 우선 복사한다', () => {
    // S37: contentPlain 은 이제 표준 MessageDto 계약의 일부다(서버 toDto + WS
    // payload 가 직렬화). 평문이 있으면 마크다운 content 보다 우선한다.
    const msg = makeMsg({ content: '**bold** raw', contentPlain: 'bold raw' });
    expect(resolveCopyPlainText(msg)).toBe('bold raw');
  });

  it('contentPlain 이 없으면 content 로 폴백한다', () => {
    const msg = makeMsg({ content: 'hello world' });
    expect(resolveCopyPlainText(msg)).toBe('hello world');
  });

  it('둘 다 없으면(첨부만) 빈 문자열', () => {
    const msg = makeMsg({ content: null });
    expect(resolveCopyPlainText(msg)).toBe('');
  });

  it('contentPlain 이 빈 문자열이면 그 값을 그대로 쓴다(?? 단락 — null 만 폴백)', () => {
    const msg = makeMsg({ content: 'fallback', contentPlain: '' });
    expect(resolveCopyPlainText(msg)).toBe('');
  });
});
