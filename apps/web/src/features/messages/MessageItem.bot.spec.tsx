/**
 * S84a (D16 / FR-RC11): 인커밍 웹훅 봇 메시지 렌더 검증.
 *
 *   - authorType==='BOT' 이면 'BOT' 배지(.qf-badge--accent)를 노출한다.
 *   - 표시 이름은 botUsername override 로 렌더한다(authorName prop 보다 우선).
 *   - 일반(USER) 메시지는 BOT 배지를 그리지 않는다.
 *
 * MessageItem 은 useCustomEmojiLookup(기본 EMPTY) / useNotifications(standalone
 * zustand)만 의존하므로 provider 없이 renderToStaticMarkup 으로 정적 렌더 가능하다
 * (MessageItem.threadChip.spec 동일 패턴).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MessageDto } from '@qufox/shared-types';
import { MessageItem } from './MessageItem';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T12:00:00Z'));
});

function makeMsg(partial: Partial<MessageDto>): MessageDto {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    channelId: '22222222-2222-4222-8222-222222222222',
    authorId: '33333333-3333-4333-8333-333333333333',
    content: 'build passed',
    contentRaw: 'build passed',
    contentAst: null,
    contentPlain: 'build passed',
    type: 'DEFAULT',
    mentions: { users: [], channels: [], everyone: false, here: false, channel: false, roles: [] },
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
    threadLocked: false,
    embeds: [],
    ...partial,
  };
}

function render(partial: Partial<MessageDto>) {
  return renderToStaticMarkup(
    <MessageItem
      msg={makeMsg(partial)}
      isMine={false}
      authorName="Real Owner"
      onEditSave={() => undefined}
      onDelete={() => undefined}
    />,
  );
}

describe('MessageItem BOT rendering (FR-RC11)', () => {
  it('renders a BOT badge and the botUsername override for webhook messages', () => {
    const html = render({ authorType: 'BOT', botUsername: 'CI Bot' });
    expect(html).toContain('qf-badge qf-badge--accent');
    expect(html).toContain('>BOT<');
    expect(html).toContain('CI Bot');
    // botUsername override 가 표시 이름이라 authorName prop 은 노출되지 않는다.
    expect(html).not.toContain('Real Owner');
  });

  it('does not render a BOT badge for a normal USER message', () => {
    const html = render({ authorType: 'USER' });
    expect(html).not.toContain('>BOT<');
    expect(html).toContain('Real Owner');
  });

  it('treats a missing authorType as USER (forward-compat)', () => {
    const html = render({});
    expect(html).not.toContain('>BOT<');
    expect(html).toContain('Real Owner');
  });
});
