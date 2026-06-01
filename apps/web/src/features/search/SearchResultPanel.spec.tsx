import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SearchResult } from '@qufox/shared-types';
import { SearchResultPanel } from './SearchResultPanel';
import {
  IN_THREAD_LABEL,
  INDEX_UPDATE_BANNER_TEXT,
  MASKED_CONTEXT_PLACEHOLDER,
  emptyStateHint,
} from './searchResultView';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

const CH = '11111111-1111-4111-8111-111111111111';
const MSG = '22222222-2222-4222-8222-222222222222';

function baseResult(over: Partial<SearchResult> = {}): SearchResult {
  return {
    messageId: MSG,
    channelId: CH,
    channelName: 'general',
    senderId: '33333333-3333-4333-8333-333333333333',
    senderName: 'alice',
    createdAt: '2025-01-01T00:00:00.000Z',
    snippet: 'hello <mark>needle</mark> world',
    rank: 0.5,
    ...over,
  };
}

function render(props: Partial<Parameters<typeof SearchResultPanel>[0]> = {}): string {
  return renderToStaticMarkup(
    <SearchResultPanel
      query="needle"
      results={[]}
      channelNameById={new Map([[CH, 'general']])}
      isLoading={false}
      hasNextPage={false}
      isFetchingNextPage={false}
      indexUpdateAvailable={false}
      recents={[]}
      onJump={() => undefined}
      onLoadMore={() => undefined}
      onReSearch={() => undefined}
      onPickRecent={() => undefined}
      onClose={() => undefined}
      {...props}
    />,
  );
}

describe('SearchResultPanel (S30)', () => {
  it('FR-S03: 0건이면 data-state=empty 컨테이너 + 수식어 힌트 DOM', () => {
    const html = render({ query: 'zznomatch', results: [] });
    expect(html).toContain('data-testid="search-panel-empty"');
    expect(html).toContain('data-state="empty"');
    // 힌트 텍스트(검색어 치환 + from:/in:/has: 안내). renderToStaticMarkup 가
    // 작은따옴표를 &#x27; 로 escape 하므로 검색어/안내 조각으로 검증한다.
    expect(emptyStateHint('zznomatch')).toContain("'zznomatch' 결과 없음.");
    expect(html).toContain('zznomatch');
    expect(html).toContain('결과 없음.');
    expect(html).toContain('from:, in:, has:로 좁혀보세요.');
  });

  it('FR-S06: 결과 카드 — 채널명 + 작성자 + 하이라이트 본문 렌더', () => {
    const html = render({ results: [baseResult()] });
    expect(html).toContain('data-testid="search-card-' + MSG + '"');
    expect(html).toContain('# general');
    expect(html).toContain('alice');
    // <mark> 하이라이트 살아있음.
    expect(html).toContain('<mark>needle</mark>');
  });

  it('FR-S06: 컨텍스트 전/후 1메시지 렌더(회색)', () => {
    const html = render({
      results: [
        baseResult({
          contextBefore: {
            messageId: 'b1111111-1111-4111-8111-111111111111',
            senderName: 'bob',
            text: 'prior line here',
            createdAt: '2024-12-31T23:59:00.000Z',
            masked: false,
          },
          contextAfter: {
            messageId: 'a1111111-1111-4111-8111-111111111111',
            senderName: 'carol',
            text: 'next line here',
            createdAt: '2025-01-01T00:01:00.000Z',
            masked: false,
          },
        }),
      ],
    });
    expect(html).toContain('data-testid="search-card-context-before"');
    expect(html).toContain('prior line here');
    expect(html).toContain('data-testid="search-card-context-after"');
    expect(html).toContain('next line here');
  });

  it('FR-S06: 권한 마스킹된 컨텍스트는 [접근 불가 메시지] placeholder', () => {
    const html = render({
      results: [
        baseResult({
          contextBefore: {
            messageId: 'b1111111-1111-4111-8111-111111111111',
            senderName: null,
            text: null,
            createdAt: '2024-12-31T23:59:00.000Z',
            masked: true,
          },
        }),
      ],
    });
    expect(html).toContain('data-masked="true"');
    expect(html).toContain(MASKED_CONTEXT_PLACEHOLDER);
  });

  it('FR-S10: 스레드 답글이면 In Thread 레이블 + 루트 excerpt', () => {
    const html = render({
      results: [baseResult({ inThread: true, threadRootExcerpt: 'root topic excerpt' })],
    });
    expect(html).toContain('data-testid="search-card-in-thread"');
    expect(html).toContain(IN_THREAD_LABEL);
    expect(html).toContain('data-testid="search-card-thread-root"');
    expect(html).toContain('root topic excerpt');
  });

  it('FR-S09: hasNextPage 면 더 보기 버튼', () => {
    const html = render({ results: [baseResult()], hasNextPage: true });
    expect(html).toContain('data-testid="search-panel-load-more"');
    expect(html).toContain('더 보기');
  });

  it('FR-S07: indexUpdateAvailable 면 재검색 배너', () => {
    const html = render({ results: [baseResult()], indexUpdateAvailable: true });
    expect(html).toContain('data-testid="search-index-update-banner"');
    expect(html).toContain(INDEX_UPDATE_BANNER_TEXT);
  });

  it('FR-S07: 빈 쿼리면 최근 검색 노출', () => {
    const html = render({ query: '', recents: ['alpha', 'beta'] });
    expect(html).toContain('data-testid="search-panel-recents"');
    expect(html).toContain('alpha');
    expect(html).toContain('beta');
    // 빈 상태에선 결과/empty 렌더 안 함.
    expect(html).not.toContain('data-state="empty"');
  });
});
