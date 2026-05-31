import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Channel } from '@qufox/shared-types';
import { useChannelList, useJoinChannel } from './useChannels';
import { useUnreadSummary } from './useUnread';
import { Icon } from '../../design-system/primitives';
import { cn } from '../../lib/cn';

type SortMode = 'name' | 'activity';

type Props = {
  workspaceId: string;
  workspaceSlug: string;
  /** ADMIN+ 만 "첫 공개 채널 만들기" CTA 가 보인다(MEMBER 미노출). */
  canManage: boolean;
  /** ADMIN+ 가 빈 상태에서 첫 채널을 만들 때 호출(채널 생성 모달 오픈). */
  onCreateChannel?: () => void;
};

/**
 * S15 (FR-CH-06): 채널 브라우저.
 *
 * 멤버가 워크스페이스의 공개 채널 목록을 이름/설명 검색 + 정렬(이름·최근 활동)로
 * 둘러보고, 클릭 한 번에 가입(S14 join 재사용)한 뒤 해당 채널로 이동한다.
 *
 * - VIEW_CHANNEL DENY 처리: 서버의 listChannels 가 호출자가 볼 수 없는 비공개
 *   채널을 이미 응답에서 제외한다(정보 누출 없음). 브라우저는 그중 **공개 채널만**
 *   추가로 노출한다(isPrivate=false).
 * - 검색: 클라이언트 필터(이름 + 설명, 대소문자 무시). 전문검색은 D07.
 * - Empty state:
 *     ① 검색 0건 → `.qf-empty` + "검색어에 해당하는 채널이 없습니다" + 초기화 링크.
 *     ② 공개 채널 자체가 없음 → layers 일러스트 + (ADMIN+) "첫 공개 채널 만들기" CTA.
 *
 * DS 토큰/기존 qf-* 클래스만 사용한다(raw hex/px 금지, DS 4파일 무수정).
 */
export function ChannelBrowser({
  workspaceId,
  workspaceSlug,
  canManage,
  onCreateChannel,
}: Props): JSX.Element {
  const { data } = useChannelList(workspaceId);
  const { data: unread } = useUnreadSummary(workspaceId);
  const join = useJoinChannel(workspaceId);
  const navigate = useNavigate();

  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortMode>('name');

  // 모든 공개 채널을 단일 평탄 목록으로 모은다(카테고리 + uncategorized).
  const publicChannels = useMemo<Channel[]>(() => {
    const all: Channel[] = [
      ...(data?.uncategorized ?? []),
      ...(data?.categories ?? []).flatMap((c) => c.channels),
    ];
    return all.filter((c) => !c.isPrivate);
  }, [data]);

  const lastActivityByChannel = useMemo(() => {
    const m = new Map<string, number>();
    for (const u of unread?.channels ?? []) {
      m.set(u.channelId, u.lastMessageAt ? new Date(u.lastMessageAt).getTime() : 0);
    }
    return m;
  }, [unread]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q
      ? publicChannels.filter(
          (c) =>
            c.name.toLowerCase().includes(q) || (c.description ?? '').toLowerCase().includes(q),
        )
      : publicChannels.slice();
    matched.sort((a, b) => {
      if (sort === 'activity') {
        const at = lastActivityByChannel.get(a.id) ?? 0;
        const bt = lastActivityByChannel.get(b.id) ?? 0;
        if (bt !== at) return bt - at; // 최근 활동 내림차순
      }
      return a.name.localeCompare(b.name);
    });
    return matched;
  }, [publicChannels, query, sort, lastActivityByChannel]);

  const onJoin = async (channel: Channel): Promise<void> => {
    await join.mutateAsync(channel.id).catch(() => undefined);
    navigate(`/w/${workspaceSlug}/${channel.name}`);
  };

  const hasNoPublicChannels = publicChannels.length === 0;
  const isSearchEmpty = !hasNoPublicChannels && filtered.length === 0;

  return (
    <div data-testid="channel-browser" className="flex h-full flex-col">
      <header className="flex items-center gap-[var(--s-3)] border-b border-border-subtle px-[var(--s-6)] py-[var(--s-4)]">
        <Icon name="layers" size="md" />
        <div className="text-[length:var(--fs-16)] font-semibold">채널 둘러보기</div>
        <div className="ml-auto flex items-center gap-[var(--s-2)]">
          <input
            type="search"
            placeholder="채널 검색"
            aria-label="채널 검색"
            data-testid="channel-browser-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="qf-input"
          />
          <label className="sr-only" htmlFor="channel-browser-sort">
            정렬
          </label>
          <select
            id="channel-browser-sort"
            data-testid="channel-browser-sort"
            aria-label="정렬"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortMode)}
            className="qf-input"
          >
            <option value="name">이름순</option>
            <option value="activity">최근 활동순</option>
          </select>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto p-[var(--s-6)]" data-testid="channel-browser-list">
        {hasNoPublicChannels ? (
          <div className="qf-empty" data-testid="channel-browser-empty-none">
            <div
              className="grid place-items-center rounded-[var(--r-xl)]"
              style={{
                width: 'var(--s-12)',
                height: 'var(--s-12)',
                background: 'var(--bg-elevated)',
              }}
              aria-hidden="true"
            >
              <Icon name="layers" size="lg" />
            </div>
            <div>
              <div className="qf-empty__title">아직 공개 채널이 없습니다</div>
              <div className="qf-empty__body">
                공개 채널을 만들면 워크스페이스 멤버 누구나 둘러보고 가입할 수 있습니다.
              </div>
            </div>
            {canManage ? (
              <button
                type="button"
                className="qf-btn qf-btn--primary"
                data-testid="channel-browser-create-first"
                onClick={() => onCreateChannel?.()}
              >
                첫 공개 채널 만들기
              </button>
            ) : null}
          </div>
        ) : isSearchEmpty ? (
          <div className="qf-empty" data-testid="channel-browser-empty-search">
            <div className="qf-empty__title">검색어에 해당하는 채널이 없습니다</div>
            <div className="qf-empty__body">
              다른 검색어를 입력하거나{' '}
              <button
                type="button"
                className="qf-btn qf-btn--link"
                data-testid="channel-browser-reset"
                onClick={() => setQuery('')}
              >
                검색 초기화
              </button>
              하세요.
            </div>
          </div>
        ) : (
          <ul className="flex flex-col gap-[var(--s-2)]">
            {filtered.map((c) => (
              <li
                key={c.id}
                data-testid={`channel-browser-row-${c.name}`}
                className="flex items-center gap-[var(--s-3)] rounded-[var(--r-md)] border border-border-subtle p-[var(--s-3)]"
                style={{ background: 'var(--bg-elevated)' }}
              >
                <span className="qf-channel__prefix" aria-hidden="true">
                  #
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[length:var(--fs-14)] font-semibold">{c.name}</div>
                  {c.description ? (
                    <div className="truncate text-[length:var(--fs-12)] text-text-muted">
                      {c.description}
                    </div>
                  ) : null}
                </div>
                <button
                  type="button"
                  className={cn('qf-btn', 'qf-btn--secondary', 'qf-btn--sm')}
                  data-testid={`channel-browser-join-${c.name}`}
                  disabled={join.isPending}
                  onClick={() => onJoin(c)}
                >
                  가입
                </button>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
