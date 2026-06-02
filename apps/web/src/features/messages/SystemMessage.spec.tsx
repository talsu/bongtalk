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
    contentPlain: contentRaw,
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
    isBroadcast: false,
    parentExcerpt: null,
    threadLocked: false,
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
    // S35 fix-forward (DS 토큰화): qf-text-danger(DS 미정의) → --danger-400 토큰.
    expect(out).toContain('text-[color:var(--danger-400)]');
    expect(out).not.toContain('qf-text-danger');
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

// ── S35 (FR-TH-06): broadcast 행 렌더 ───────────────────────────────────────
describe('SystemMessage broadcast row (FR-TH-06)', () => {
  function broadcastMsg(overrides: Partial<MessageDto> = {}): MessageDto {
    return {
      ...makeMsg('SYSTEM_THREAD_BROADCAST', 'reply body'),
      isBroadcast: true,
      parentMessageId: '33333333-3333-3333-3333-333333333333',
      parentExcerpt: '루트 메시지 일부',
      ...overrides,
    };
  }

  it('renders the "스레드에 답글" label + root excerpt + reply body', () => {
    const out = renderToStaticMarkup(<SystemMessage msg={broadcastMsg()} />);
    expect(out).toContain('스레드에 답글');
    expect(out).toContain('루트 메시지 일부');
    expect(out).toContain('reply body');
    expect(out).toContain('data-broadcast="true"');
  });

  it('renders as a clickable button when onOpenThread is provided', () => {
    const out = renderToStaticMarkup(
      <SystemMessage msg={broadcastMsg()} onOpenThread={() => undefined} />,
    );
    expect(out).toContain('<button');
    // A-06/A-12: aria-label 에 루트 excerpt 가 실린다.
    expect(out).toContain('aria-label="스레드 열기: 루트 메시지 일부"');
    // A-07: 활성 <button> 은 암묵 role=button 이라 중복 role="button" 을 두지 않는다.
    expect(out).not.toContain('role="button"');
  });

  it('falls back to a plain open label when there is no excerpt (A-06)', () => {
    const out = renderToStaticMarkup(
      <SystemMessage msg={broadcastMsg({ parentExcerpt: null })} onOpenThread={() => undefined} />,
    );
    expect(out).toContain('aria-label="스레드 열기"');
    expect(out).not.toContain('스레드 열기:');
  });

  it('shows placeholder + no body when the broadcast row is deleted', () => {
    const out = renderToStaticMarkup(
      <SystemMessage
        msg={broadcastMsg({ deleted: true, content: null, parentExcerpt: null })}
        onOpenThread={() => undefined}
      />,
    );
    expect(out).toContain('(삭제된 메시지)');
    // 삭제된 broadcast 는 클릭 불가(button 아님 — div).
    expect(out).not.toContain('aria-label="스레드 열기"');
    // A-07: 삭제 broadcast 의 정적 div 에 role="status" 를 부여하지 않는다(announce 회피).
    expect(out).not.toContain('role="status"');
  });
});
