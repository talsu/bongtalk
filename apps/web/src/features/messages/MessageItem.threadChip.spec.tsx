/**
 * S34 (FR-TH-03): reply bar(qf-thread-chip) 렌더 검증.
 *
 * 검증 항목:
 *   - 최초 답글자 아바타는 최대 5명까지만 렌더한다(PRD "≤5").
 *   - latestReplyAt 은 절대 시각이 아니라 상대 시각(formatMessageTime —
 *     오늘/어제/N일 전)으로 표시한다.
 *   - 아바타는 표시명 유무와 무관하게 Avatar primitive 로 단일화한다(S34
 *     fix-forward DS #4): resolveName 으로 풀면 그 이름 이니셜, 못 풀면 uid
 *     이니셜로 렌더한다. raw hsl 인라인 / 중복 colorFromSeed 는 제거됐다.
 *   - chip aria-label 에 마지막 답글 시각이 포함된다(S34 fix-forward a11y #3).
 *   - lastRepliedAt 은 <time dateTime> 으로 기계 판독 가능하게 렌더한다.
 *
 * MessageItem 은 useCustomEmojiLookup(기본 EMPTY 컨텍스트) / useNotifications
 * (standalone zustand store)만 의존하므로 provider 없이 정적 렌더 가능하다
 * (SystemMessage.spec 와 동일 패턴: renderToStaticMarkup).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MessageDto, ThreadSummary } from '@qufox/shared-types';
import { MessageItem } from './MessageItem';

beforeEach(() => {
  // 결정적 상대 시각 계산 기준 시각.
  vi.setSystemTime(new Date('2025-01-01T12:00:00Z'));
});

function makeMsg(thread: ThreadSummary | null): MessageDto {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    channelId: '22222222-2222-4222-8222-222222222222',
    authorId: '33333333-3333-4333-8333-333333333333',
    content: 'root message',
    contentRaw: 'root message',
    contentAst: null,
    contentPlain: 'root message',
    type: 'DEFAULT',
    mentions: { users: [], channels: [], everyone: false, here: false, channel: false, roles: [] },
    edited: false,
    deleted: false,
    createdAt: '2025-01-01T00:00:00.000Z',
    editedAt: null,
    reactions: [],
    parentMessageId: null,
    thread,
    attachments: [],
    pinnedAt: null,
    pinnedBy: null,
    version: 0,
    isBroadcast: false,
    parentExcerpt: null,
    threadLocked: false,
    embeds: [],
  };
}

function render(thread: ThreadSummary | null, resolveName?: (id: string) => string | undefined) {
  return renderToStaticMarkup(
    <MessageItem
      msg={makeMsg(thread)}
      isMine={false}
      onEditSave={() => undefined}
      onDelete={() => undefined}
      onOpenThread={() => undefined}
      resolveName={resolveName}
    />,
  );
}

describe('MessageItem reply bar (FR-TH-03)', () => {
  it('renders at most 5 recent-replier avatars (cap ≤5)', () => {
    const sevenUserIds = Array.from(
      { length: 7 },
      (_v, i) => `aaaaaaaa-aaaa-4aaa-8aaa-00000000000${i}`,
    );
    const thread: ThreadSummary = {
      replyCount: 7,
      lastRepliedAt: '2025-01-01T11:30:00.000Z',
      recentReplyUserIds: sevenUserIds,
      hasUnread: false,
    };
    const html = render(thread);
    // qf-avatar--xs 가 chip 아바타 클래스 — 최대 5개만 등장해야 한다.
    const avatarMatches = html.match(/qf-avatar--xs/g) ?? [];
    expect(avatarMatches).toHaveLength(5);
  });

  it('renders relative time (오늘 → HH:MM) not toLocaleTimeString', () => {
    const thread: ThreadSummary = {
      replyCount: 2,
      // now=2025-01-01T12:00Z 기준 같은 달력 일 → 시각만 노출(상대 시각).
      lastRepliedAt: '2025-01-01T11:30:00.000Z',
      recentReplyUserIds: ['aaaaaaaa-aaaa-4aaa-8aaa-000000000001'],
      hasUnread: false,
    };
    const html = render(thread);
    expect(html).toContain('마지막 답글');
    // formatMessageTime 의 "어제/N일 전" 분기 검증: 이틀 전 답글.
    const olderThread: ThreadSummary = {
      replyCount: 2,
      lastRepliedAt: '2024-12-30T11:30:00.000Z',
      recentReplyUserIds: ['aaaaaaaa-aaaa-4aaa-8aaa-000000000001'],
      hasUnread: false,
    };
    const olderHtml = render(olderThread);
    expect(olderHtml).toContain('2일 전');
  });

  it('uses resolved display-name initials when resolveName provides a name', () => {
    const uid = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
    const thread: ThreadSummary = {
      replyCount: 1,
      lastRepliedAt: '2025-01-01T11:30:00.000Z',
      recentReplyUserIds: [uid],
      hasUnread: false,
    };
    const html = render(thread, (id) => (id === uid ? 'Alice' : undefined));
    // Avatar primitive 는 name.slice(0,2).toUpperCase() = 'AL' 을 렌더한다.
    expect(html).toContain('AL');
  });

  it('falls back to a uid-seeded Avatar when resolveName returns undefined (DS #4)', () => {
    const uid = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
    const thread: ThreadSummary = {
      replyCount: 1,
      lastRepliedAt: '2025-01-01T11:30:00.000Z',
      recentReplyUserIds: [uid],
      hasUnread: false,
    };
    const html = render(thread, () => undefined);
    // S34 fix-forward (DS #4): 표시명을 못 풀면 raw hsl 빈 점이 아니라 uid 로
    // 시드된 Avatar primitive 를 렌더한다. uid 첫 2글자 이니셜('AA')이 나온다.
    expect(html).toContain('qf-avatar--xs');
    expect(html).toContain('AA');
  });

  it('aria-label 에 답글 수 + 마지막 답글 시각을 포함한다 (a11y #3)', () => {
    const thread: ThreadSummary = {
      replyCount: 3,
      lastRepliedAt: '2025-01-01T11:30:00.000Z',
      recentReplyUserIds: ['aaaaaaaa-aaaa-4aaa-8aaa-000000000001'],
      hasUnread: false,
    };
    const html = render(thread);
    expect(html).toContain('aria-label="3개 답글 보기, 마지막 답글');
  });

  it('lastRepliedAt 없으면 aria-label 에 시각 절을 생략한다 (a11y #3)', () => {
    const thread: ThreadSummary = {
      replyCount: 2,
      lastRepliedAt: null,
      recentReplyUserIds: ['aaaaaaaa-aaaa-4aaa-8aaa-000000000001'],
      hasUnread: false,
    };
    const html = render(thread);
    expect(html).toContain('aria-label="2개 답글 보기"');
  });

  it('lastRepliedAt 을 <time dateTime> 으로 렌더한다 (a11y #3)', () => {
    const thread: ThreadSummary = {
      replyCount: 1,
      lastRepliedAt: '2025-01-01T11:30:00.000Z',
      recentReplyUserIds: ['aaaaaaaa-aaaa-4aaa-8aaa-000000000001'],
      hasUnread: false,
    };
    const html = render(thread);
    // qf-thread-chip__last 는 이제 <time> 이며 dateTime 속성을 가진다.
    // (renderToStaticMarkup 은 React 의 dateTime 속성을 camelCase 그대로 출력)
    expect(html).toMatch(
      /<time[^>]*class="qf-thread-chip__last"[^>]*dateTime="2025-01-01T11:30:00.000Z"/,
    );
  });

  // S36 (FR-TH-04 / FR-TH-11): per-viewer 스레드 미읽 dot.
  it('hasUnread=true 면 reply bar 에 파란 unread dot 을 렌더한다 (FR-TH-04)', () => {
    const thread: ThreadSummary = {
      replyCount: 3,
      lastRepliedAt: '2025-01-01T11:30:00.000Z',
      recentReplyUserIds: ['aaaaaaaa-aaaa-4aaa-8aaa-000000000001'],
      hasUnread: true,
    };
    const html = render(thread);
    // dot 은 data-testid=thread-unread-dot-* 로 식별 + DS accent 토큰 배경.
    expect(html).toContain('data-testid="thread-unread-dot-');
    expect(html).toContain('var(--accent)');
    // a11y: aria-label 에 "안 읽은 답글" 접두가 붙는다.
    expect(html).toContain('안 읽은 답글');
  });

  it('hasUnread=false 면 unread dot 을 렌더하지 않는다 (FR-TH-04)', () => {
    const thread: ThreadSummary = {
      replyCount: 3,
      lastRepliedAt: '2025-01-01T11:30:00.000Z',
      recentReplyUserIds: ['aaaaaaaa-aaaa-4aaa-8aaa-000000000001'],
      hasUnread: false,
    };
    const html = render(thread);
    expect(html).not.toContain('data-testid="thread-unread-dot-');
    expect(html).not.toContain('안 읽은 답글');
  });
});
