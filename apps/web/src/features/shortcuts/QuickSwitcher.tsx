import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useUI } from '../../stores/ui-store';
import { useAuth } from '../auth/AuthProvider';
import { useMyWorkspaces, useMembers } from '../workspaces/useWorkspaces';
import { useChannelList } from '../channels/useChannels';
import { useUnreadSummary } from '../channels/useUnread';
import { useDmList } from '../dms/useDms';
import { useChannelLruStore } from '../realtime/channelLru';
import { resolveMemberDisplayName } from '@qufox/shared-types';
import { Dialog, Input } from '../../design-system/primitives';
import { announce } from '../../lib/a11y-announce';
import { rankQuickSwitcher, type RankableQsItem } from './rankQuickSwitcher';

/**
 * S82a (FR-KS-01/02/03/11) — 퀵스위처(채널/멤버/DM 빠른 이동).
 *
 * Cmd/Ctrl+K 로 열리는 별도 모달입니다. 기존 액션 팰릿(CommandPalette)은 보존하고
 * Cmd+Shift+K 로 재바인딩했습니다(useShortcut). 모든 데이터는 기존 훅에서 받아
 * (채널 useChannelList · 멤버 useMembers · DM useDmList · 미읽 useUnreadSummary)
 * 클라이언트에서 퍼지 랭킹(rankQuickSwitcher)합니다.
 *
 * 워크스페이스 스코프: 채널/멤버/미읽은 현재 워크스페이스(slug→wsId) 한정,
 * DM 은 전역입니다. 워크스페이스 밖(slug 없음)에서는 채널/멤버가 비고 DM 만
 * 노출됩니다.
 *
 * 접두 필터: `#` = 채널만, `@` = 멤버/DM 만. 그 외에는 세 종류를 함께 검색합니다.
 *
 * 기본 화면(쿼리 없음): 최근 방문 채널/DM(최대 5) + 미읽 채널 상위(최대 5).
 * 최근 채널은 useChannelLruStore.order(tail=최신)에서, 최근 DM 은 useDmList 의
 * lastMessageAt 내림차순으로 근사합니다(별도 방문 store 신설 없이 — 보고 참고).
 */

type Target = { kind: 'channel'; channelName: string } | { kind: 'dm'; userId: string };

interface QsRow {
  item: RankableQsItem;
  target: Target;
  /** 표시용 보조 라벨(예: '채널' / 'DM' / '@handle'). */
  meta?: string;
}

const SECTION_LIMIT = 5;
const SEARCH_LIMIT = 8;

export function QuickSwitcher(): JSX.Element | null {
  const openModal = useUI((s) => s.openModal);
  const setOpenModal = useUI((s) => s.setOpenModal);
  const navigate = useNavigate();
  const { slug } = useParams<{ slug: string }>();
  const { user } = useAuth();
  const { data: mine } = useMyWorkspaces();
  const currentWorkspaceId = mine?.workspaces.find((w) => w.slug === slug)?.id;

  const { data: channels } = useChannelList(currentWorkspaceId);
  const { data: members } = useMembers(currentWorkspaceId);
  const { data: unread } = useUnreadSummary(currentWorkspaceId);
  const { data: dms } = useDmList(currentWorkspaceId);
  const lruOrder = useChannelLruStore((s) => s.order);

  const [query, setQuery] = useState('');
  const [focusIdx, setFocusIdx] = useState(0);

  const isOpen = openModal === 'quick-switcher';

  // 모달이 새로 열릴 때마다 쿼리/포커스를 초기화한다(직전 검색어 잔존 방지).
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setFocusIdx(0);
    }
  }, [isOpen]);

  // ── 후보 항목 구성 (종류별 RankableQsItem + 라우팅 target) ────────────────
  const channelRows = useMemo<QsRow[]>(() => {
    if (!slug || !channels) return [];
    const flat = [...channels.uncategorized, ...channels.categories.flatMap((c) => c.channels)];
    const unreadById = new Map(unread?.channels.map((c) => [c.channelId, c.unreadCount]) ?? []);
    return flat.map((ch) => {
      const unreadCount = unreadById.get(ch.id) ?? 0;
      return {
        item: {
          id: `ch:${ch.id}`,
          kind: 'channel' as const,
          label: ch.name,
          boost: unreadCount > 0 ? 1 : 0,
        },
        target: { kind: 'channel' as const, channelName: ch.name },
        meta: unreadCount > 0 ? `미읽음 ${unreadCount}` : '채널',
      };
    });
  }, [slug, channels, unread]);

  const memberRows = useMemo<QsRow[]>(() => {
    if (!currentWorkspaceId || !members) return [];
    return members.members
      .filter((m) => m.userId !== user?.id) // 자기 자신은 DM 대상에서 제외
      .map((m) => {
        const display = resolveMemberDisplayName(m.user);
        const online = m.status !== 'offline';
        return {
          item: {
            id: `mem:${m.userId}`,
            kind: 'member' as const,
            label: display,
            keywords: [m.user.username],
            boost: online ? 1 : 0,
          },
          target: { kind: 'dm' as const, userId: m.userId },
          meta: `@${m.user.username}`,
        };
      });
  }, [currentWorkspaceId, members, user?.id]);

  // DM 행: 멤버 행과 같은 user 를 가리키면 멤버 행이 우선이라 중복을 피한다(멤버
  // id 집합으로 dedupe). 워크스페이스 밖(멤버 비어 있음)에서는 DM 만으로 채워진다.
  const dmRows = useMemo<QsRow[]>(() => {
    const memberUserIds = new Set(memberRows.map((r) => (r.target as { userId: string }).userId));
    return (dms?.items ?? [])
      .filter((d) => d.otherUserId !== user?.id && !memberUserIds.has(d.otherUserId))
      .map((d) => ({
        item: {
          id: `dm:${d.otherUserId}`,
          kind: 'dm' as const,
          label: d.otherUsername,
          boost: d.unreadCount > 0 ? 1 : 0,
        },
        target: { kind: 'dm' as const, userId: d.otherUserId },
        meta: d.unreadCount > 0 ? `미읽음 ${d.unreadCount}` : 'DM',
      }));
  }, [dms, user?.id, memberRows]);

  const byId = useMemo(() => {
    const map = new Map<string, QsRow>();
    for (const r of [...channelRows, ...memberRows, ...dmRows]) map.set(r.item.id, r);
    return map;
  }, [channelRows, memberRows, dmRows]);

  // 최근 방문 id 목록(앞일수록 최근). 채널 LRU(tail=최신)를 역순으로 + DM
  // lastMessageAt 내림차순을 합쳐 근사한다.
  const recentIds = useMemo<string[]>(() => {
    const recentChannels = [...lruOrder]
      .reverse()
      .map((key) => {
        const channelId = key.slice(key.indexOf('::') + 2);
        return `ch:${channelId}`;
      })
      .filter((id) => byId.has(id));
    const recentDms = (dms?.items ?? [])
      .filter((d) => d.lastMessageAt)
      .sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''))
      .map((d) => `dm:${d.otherUserId}`)
      .filter((id) => byId.has(id) || byId.has(`mem:${id.slice(3)}`));
    return [...recentChannels, ...recentDms];
  }, [lruOrder, dms, byId]);

  // ── 표시할 행 계산 ────────────────────────────────────────────────────────
  const rows = useMemo<QsRow[]>(() => {
    const raw = query.trim();
    const prefix = raw.startsWith('#') ? '#' : raw.startsWith('@') ? '@' : '';
    const bare = prefix ? raw.slice(1) : raw;

    if (bare.length === 0 && !prefix) {
      // FR-KS-02: 기본 화면 — 최근 방문 5 + 미읽 채널 상위 5.
      const recentRows = recentIds
        .map((id) => byId.get(id) ?? byId.get(`mem:${id.slice(3)}`))
        .filter((r): r is QsRow => Boolean(r))
        .slice(0, SECTION_LIMIT);
      const recentSet = new Set(recentRows.map((r) => r.item.id));
      const unreadRows = channelRows
        .filter((r) => (r.item.boost ?? 0) > 0 && !recentSet.has(r.item.id))
        .slice(0, SECTION_LIMIT);
      return [...recentRows, ...unreadRows];
    }

    // 접두 필터로 후보 종류를 좁힌다.
    let pool: QsRow[];
    if (prefix === '#') pool = channelRows;
    else if (prefix === '@') pool = [...memberRows, ...dmRows];
    else pool = [...channelRows, ...memberRows, ...dmRows];

    const ranked = rankQuickSwitcher({
      items: pool.map((r) => r.item),
      query: bare,
      recent: recentIds,
      limit: SEARCH_LIMIT,
    });
    return ranked.map((it) => byId.get(it.id)).filter((r): r is QsRow => Boolean(r));
  }, [query, recentIds, byId, channelRows, memberRows, dmRows]);

  // FR-KS-01: 결과 수 변경 시 스크린리더 공지(공유 announcer).
  useEffect(() => {
    if (!isOpen) return;
    announce(`${rows.length}개 결과`);
  }, [isOpen, rows.length]);

  function go(row: QsRow): void {
    if (row.target.kind === 'channel') {
      if (slug) navigate(`/w/${slug}/${row.target.channelName}`);
    } else {
      navigate(`/dm/${row.target.userId}`);
    }
    setOpenModal(null);
  }

  if (!isOpen) return null;

  const listboxId = 'quick-switcher-listbox';
  const optionId = (i: number): string => `quick-switcher-option-${i}`;
  const activeId = rows.length > 0 ? optionId(focusIdx) : undefined;
  const isEmpty = rows.length === 0;

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(v) => setOpenModal(v ? 'quick-switcher' : null)}
      title="채널/멤버/DM 이동"
      description="이름을 입력해 채널·멤버·DM 으로 빠르게 이동합니다."
      className="max-w-lg"
    >
      <Input
        data-testid="quick-switcher-input"
        aria-label="채널/멤버/DM 이동"
        autoFocus
        placeholder="채널 · 멤버 · DM 검색 (# 채널만, @ 멤버/DM만)"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={true}
        aria-controls={listboxId}
        aria-activedescendant={activeId}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setFocusIdx(0);
        }}
        onKeyDown={(e) => {
          // IME(한글 조합) 가드 — 조합 확정 Enter 가 첫 항목을 실행하지 않게 한다.
          const native = e.nativeEvent as KeyboardEvent & { isComposing?: boolean };
          if (native.isComposing || e.keyCode === 229) return;
          if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
            e.preventDefault();
            setFocusIdx((i) => (rows.length === 0 ? 0 : Math.min(i + 1, rows.length - 1)));
          } else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
            e.preventDefault();
            setFocusIdx((i) => Math.max(i - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            const row = rows[focusIdx];
            if (row) go(row);
          }
        }}
      />
      {isEmpty ? (
        <div
          data-testid="quick-switcher-empty"
          data-state="empty"
          className="qf-empty !py-[var(--s-7)]"
        >
          <div className="qf-empty__body">
            <p>검색 결과가 없습니다.</p>
            <p className="mt-[var(--s-2)] text-text-muted">
              새 DM 을 시작하려면 <span className="qf-menu__kbd">Ctrl+N</span> 을 누르세요.
            </p>
            {slug ? (
              <button
                type="button"
                data-testid="quick-switcher-browse"
                className="qf-btn qf-btn--ghost qf-btn--sm mt-[var(--s-3)]"
                onClick={() => {
                  navigate(`/w/${slug}`);
                  setOpenModal(null);
                }}
              >
                채널 둘러보기
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <ul id={listboxId} role="listbox" className="mt-[var(--s-4)] max-h-72 overflow-y-auto">
          {rows.map((row, i) => (
            <li
              key={row.item.id}
              id={optionId(i)}
              role="option"
              aria-selected={i === focusIdx}
              data-testid={`quick-switcher-item-${i}`}
              data-kind={row.item.kind}
              onMouseEnter={() => setFocusIdx(i)}
              onClick={() => go(row)}
              className="qf-menu__item justify-between"
              style={{
                background: i === focusIdx ? 'var(--bg-selected)' : 'transparent',
                color: i === focusIdx ? 'var(--text-strong)' : 'var(--text-secondary)',
              }}
            >
              <span>
                <span aria-hidden="true" className="text-text-muted">
                  {row.item.kind === 'channel' ? '# ' : '@ '}
                </span>
                {row.item.label}
              </span>
              {row.meta ? <span className="qf-menu__kbd">{row.meta}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
