// @vitest-environment jsdom
/**
 * S84c (D16 / FR-RC19): 링크 미리보기 전역 토글 렌더 게이트.
 *   - linkPreviewsEnabled=false → unfurl embed(서버 OG 카드)를 렌더하지 않는다.
 *   - 단, 봇 rich embed(msg.richEmbeds)는 링크 미리보기가 아니므로 계속 렌더한다.
 *   - linkPreviewsEnabled=true(기본) → unfurl embed 정상 렌더.
 *
 * appearance-store(zustand 싱글톤)의 라이브 값에 의존하므로 SSR(renderToStaticMarkup,
 * zustand 초기 스냅샷만 읽음)이 아니라 testing-library client 렌더로 검증한다. MessageItem
 * 은 server embed 경로(useQuery 미사용)라 provider 없이 렌더 가능하다(threadChip 선례).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { DEFAULT_APPEARANCE, type MessageDto } from '@qufox/shared-types';
import { MessageItem } from './MessageItem';
import { useAppearanceStore } from '../../stores/appearance-store';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T12:00:00Z'));
});

afterEach(() => {
  cleanup();
  useAppearanceStore.getState().set({ ...DEFAULT_APPEARANCE });
});

function makeMsg(): MessageDto {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    channelId: '22222222-2222-4222-8222-222222222222',
    authorId: '33333333-3333-4333-8333-333333333333',
    content: 'see the link',
    contentRaw: 'see the link',
    contentAst: null,
    contentPlain: 'see the link',
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
    threadLocked: false,
    embeds: [
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        url: 'https://example.com',
        title: 'Example Site',
        description: 'an example',
        siteName: 'example.com',
        imageProxyUrl: null,
        suppressedAt: null,
      },
    ],
    richEmbeds: [{ title: 'Bot Embed', description: 'from a webhook' }],
  };
}

function renderItem() {
  return render(
    <MessageItem
      msg={makeMsg()}
      isMine={false}
      onEditSave={() => undefined}
      onDelete={() => undefined}
    />,
  );
}

describe('MessageItem link-preview toggle (FR-RC19)', () => {
  it('renders the unfurl embed when link previews are enabled (default)', () => {
    useAppearanceStore.getState().set({ ...DEFAULT_APPEARANCE, linkPreviewsEnabled: true });
    const { container } = renderItem();
    expect(container.innerHTML).toContain('Example Site');
    expect(container.innerHTML).toContain('Bot Embed');
  });

  it('skips the unfurl embed but keeps the bot rich embed when disabled', () => {
    useAppearanceStore.getState().set({ ...DEFAULT_APPEARANCE, linkPreviewsEnabled: false });
    const { container } = renderItem();
    expect(container.innerHTML).not.toContain('Example Site');
    // 봇 rich embed 는 링크 미리보기가 아니므로 계속 렌더된다.
    expect(container.innerHTML).toContain('Bot Embed');
  });
});
