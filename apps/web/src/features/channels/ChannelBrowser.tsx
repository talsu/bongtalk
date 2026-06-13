import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ChannelBrowseItem } from '@qufox/shared-types';
import { useBrowsableChannels, useJoinChannel } from './useChannels';
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
 * 둘러보고, 가입(S14 join 재사용) 또는 이미 가입한 채널은 바로 열어 이동한다.
 *
 * - 데이터 소스(072 S-D): 전용 둘러보기 엔드포인트 listBrowsable(useBrowsableChannels).
 *   서버가 **공개·비보관·비삭제 채널만** 반환하므로 클라 isPrivate 필터는 불요하며,
 *   각 항목에 memberCount(가입 멤버 수) + isMember(호출자 가입 여부)를 동봉한다.
 *   isMember 로 "가입"/"열기" 버튼을 분기하고 memberCount 를 표시한다.
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
  // 072 백로그 S-D (FR-CH-06): 서버가 공개 채널 + memberCount + isMember 를 내려준다
  // (사이드바 핫패스 listByWorkspace 와 분리된 전용 둘러보기 엔드포인트).
  const { data } = useBrowsableChannels(workspaceId);
  const { data: unread } = useUnreadSummary(workspaceId);
  const join = useJoinChannel(workspaceId);
  const navigate = useNavigate();

  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortMode>('name');

  // 서버가 공개 채널만 반환하므로 그대로 사용한다(클라 isPrivate 필터 불요).
  const publicChannels = useMemo<ChannelBrowseItem[]>(() => data?.channels ?? [], [data]);

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

  // 072 백로그 S-D: 이미 가입(isMember)한 채널은 바로 열고, 아니면 가입 후 이동한다.
  const onOpenOrJoin = async (channel: ChannelBrowseItem): Promise<void> => {
    if (!channel.isMember) {
      await join.mutateAsync(channel.id).catch(() => undefined);
    }
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
                {/* 072 백로그 S-D: 가입(opt-in) 멤버 수. 0 명도 명시(빈칸 방지). */}
                <span
                  data-testid={`channel-browser-membercount-${c.name}`}
                  className="shrink-0 text-[length:var(--fs-12)] text-text-muted"
                >
                  멤버 {c.memberCount.toLocaleString()}명
                </span>
                {/* 이미 가입했으면 "열기", 아니면 "가입" — isMember 로 분기. */}
                <button
                  type="button"
                  className={cn(
                    'qf-btn',
                    c.isMember ? 'qf-btn--ghost' : 'qf-btn--secondary',
                    'qf-btn--sm',
                  )}
                  data-testid={
                    c.isMember ? `channel-browser-open-${c.name}` : `channel-browser-join-${c.name}`
                  }
                  // a11y(S-D 리뷰 LOW): 버튼 접근명에 채널명 합성(rotor 순회 시 동일 라벨
                  // N개 모호성 해소 — UnreadsView/FavoritesSection 선례 일관).
                  aria-label={c.isMember ? `# ${c.name} 채널 열기` : `# ${c.name} 채널 가입`}
                  // S-D 리뷰 LOW: "열기"는 join 뮤테이션을 안 쓰므로 가입 진행 중에도
                  // 비활성화하지 않는다(무관한 가입 동작이 멤버 채널 열기를 막지 않게).
                  disabled={!c.isMember && join.isPending}
                  onClick={() => onOpenOrJoin(c)}
                >
                  {c.isMember ? '열기' : '가입'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
