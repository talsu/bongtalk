import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MessageDto, MessageType } from '@qufox/shared-types';
import { SystemMessage } from './SystemMessage';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

function makeMsg(type: MessageType, contentRaw: string): MessageDto {
  return {
    id: 'sys-1',
    channelId: '11111111-1111-1111-1111-111111111111',
    authorId: '22222222-2222-2222-2222-222222222222',
    content: contentRaw,
    contentRaw,
    contentAst: null,
    type,
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
  };
}

function html(type: MessageType, contentRaw: string): string {
  return renderToStaticMarkup(<SystemMessage msg={makeMsg(type, contentRaw)} />);
}

describe('SystemMessage (FR-MSG-19 / FR-RC10)', () => {
  it('renders the server-generated template text', () => {
    const out = html('SYSTEM_MEMBER_JOINED', 'alice이(가) 서버에 참가했습니다.');
    expect(out).toContain('alice이(가) 서버에 참가했습니다.');
  });

  it('renders an icon (no avatar header)', () => {
    const out = html('SYSTEM_MEMBER_JOINED', 'alice이(가) 서버에 참가했습니다.');
    expect(out).toContain('qf-icon');
    // no avatar element on a system row
    expect(out).not.toContain('qf-message__avatar');
    // no author meta header
    expect(out).not.toContain('qf-message__author');
  });

  it('does NOT render edit/delete context-menu DOM nodes (AC FR-MSG-19)', () => {
    const out = html('SYSTEM_MEMBER_BANNED', 'bob이(가) 추방되었습니다.');
    expect(out).not.toContain('msg-more-btn');
    expect(out).not.toContain('msg-edit-btn');
    expect(out).not.toContain('msg-delete');
    expect(out).not.toContain('메시지 수정');
    expect(out).not.toContain('메시지 삭제');
  });

  it('applies danger tone for SYSTEM_MEMBER_BANNED', () => {
    const out = html('SYSTEM_MEMBER_BANNED', 'bob이(가) 추방되었습니다.');
    expect(out).toContain('qf-text-danger');
  });

  it('applies muted tone for SYSTEM_CHANNEL_ARCHIVED', () => {
    const out = html('SYSTEM_CHANNEL_ARCHIVED', 'mod이(가) 채널을 보관했습니다.');
    expect(out).toContain('text-text-muted');
  });

  it('carries data-message-type for grouping/e2e selectors', () => {
    const out = html('SYSTEM_PIN', 'alice이(가) 메시지를 고정했습니다.');
    expect(out).toContain('data-message-type="SYSTEM_PIN"');
  });

  it('uses the .qf-message--system DS hook class', () => {
    const out = html('SYSTEM_MEMBER_JOINED', 'alice이(가) 서버에 참가했습니다.');
    expect(out).toContain('qf-message--system');
  });

  it('escapes HTML in the template text (XSS guard)', () => {
    const out = html('SYSTEM_CHANNEL_RENAME', '<script>alert(1)</script>');
    expect(out).not.toContain('<script>alert(1)</script>');
  });
});
