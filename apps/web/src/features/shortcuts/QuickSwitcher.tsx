import { useEffect, useMemo, useRef, useState } from 'react';
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
 * (채널 useChannelList · 멤버 useMembers · DM useDmList · 읽지 않음 useUnreadSummary)
 * 클라이언트에서 퍼지 랭킹(rankQuickSwitcher)합니다.
 *
 * 워크스페이스 스코프: 채널/멤버/읽지 않음은 현재 워크스페이스(slug→wsId) 한정,
 * DM 은 전역입니다. 워크스페이스 밖(slug 없음)에서는 채널/멤버가 비고 DM 만
 * 노출됩니다.
 *
 * 접두 필터: `#` = 채널만, `@` = 멤버/DM 만. 그 외에는 세 종류를 함께 검색합니다.
 *
 * 기본 화면(쿼리 없음): 최근 방문 채널/DM(최대 5) + 읽지 않은 채널 상위(최대 5).
 * 최근 채널은 useChannelLruStore.order(tail=최신)에서, 최근 DM 은 useDmList 의
 * lastMessageAt 내림차순으로 근사합니다(별도 방문 store 신설 없이 — 보고 참고).
 *
 * S82a fix-forward (perf #1 = #9): 닫힘 중에도 데이터 훅 + memo 가 WS 이벤트마다
 * 재계산되지 않도록, 외부 컴포넌트는 openModal 만 구독하는 thin wrapper 로 두고
 * 실제 데이터 훅/memo/렌더는 inner(QuickSwitcherModal)로 옮겨 isOpen 시에만
 * 마운트합니다(닫힘 시 언마운트 → 재계산 0).
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

/** 종류 한국어 라벨(SR aria-label 접두). */
const KIND_LABEL: Record<RankableQsItem['kind'], string> = {
  channel: '채널',
  member: '멤버',
  dm: 'DM',
};

/**
 * S82a fix-forward (perf #1 = #9): thin wrapper. openModal 만 구독해 닫힘 중에는
 * 어떤 데이터 훅/memo 도 돌지 않습니다. 열릴 때만 inner 를 마운트합니다.
 */
export function QuickSwitcher(): JSX.Element | null {
  const isOpen = useUI((s) => s.openModal === 'quick-switcher');
  if (!isOpen) return null;
  return <QuickSwitcherModal />;
}

/**
 * 실제 모달 본체. 마운트 = 열림이므로 데이터 훅/memo 는 열려 있는 동안에만 돕니다.
 */
function QuickSwitcherModal(): JSX.Element {
  const setOpenModal = useUI((s) => s.setOpenModal);
  const navigate = useNavigate();
  const { slug } = useParams<{ slug: string }>();
  const { user } = useAuth();
  const { data: mine } = useMyWorkspaces();
  const currentWorkspaceId = mine?.workspaces.find((w) => w.slug === slug)?.id;

  const { data: channels } = useChannelList(currentWorkspaceId);
  const { data: members } = useMembers(currentWorkspaceId);
  const { data: unread } = useUnreadSummary(currentWorkspaceId);
  // S82a fix-forward (reviewer NIT-1): useDmList 는 인자와 무관하게 /me/dms 전역
  // 캐시를 공유하므로(useDms.ts 주석) undefined 로 호출해 캐시 키를 통일한다.
  const { data: dms } = useDmList(undefined);
  const lruOrder = useChannelLruStore((s) => s.order);

  const [query, setQuery] = useState('');
  const [focusIdx, setFocusIdx] = useState(0);

  // S82a fix-forward (a11y #3): 열릴 때(=마운트 시) 직전 포커스 요소를 저장해 두고,
  // 닫힐 때(언마운트) 그 요소로 포커스를 복원한다. Cmd+K 는 window keydown 트리거라
  // Radix 가 트리거를 알지 못해(body 로 포커스를 보냄) onCloseAutoFocus 만으로는
  // 복원 대상이 없으므로, 컴포넌트 레벨에서 명시적으로 보관/복원한다(공유 Dialog
  // primitive 무수정). 복원 대상이 사라졌으면 옵셔널 체이닝으로 무시한다.
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      // 언마운트(닫힘) 시 트리거로 포커스 복원. 사라졌으면 무시.
      restoreFocusRef.current?.focus?.();
    };
    // 마운트/언마운트 1회만 — 의존성 없음(열림=마운트 구조라 안정적).
  }, []);

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
        meta: unreadCount > 0 ? `읽지 않음 ${unreadCount}` : '채널',
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
        meta: d.unreadCount > 0 ? `읽지 않음 ${d.unreadCount}` : 'DM',
      }));
  }, [dms, user?.id, memberRows]);

  const byId = useMemo(() => {
    const map = new Map<string, QsRow>();
    for (const r of [...channelRows, ...memberRows, ...dmRows]) map.set(r.item.id, r);
    return map;
  }, [channelRows, memberRows, dmRows]);

  // 최근 방문 id 목록(앞일수록 최근). 채널 LRU(tail=최신)를 역순으로 + DM
  // lastMessageAt 내림차순을 합쳐 근사한다.
  //
  // S82a fix-forward (reviewer MED-1): 어떤 상대가 멤버이기도 하면 그 행 id 는
  // `mem:${userId}` 이고(멤버 행 우선·dmRows 에서 dedupe 됨), recentIds 에 `dm:` id
  // 를 push 하면 랭킹 recency 부스트가 행과 키가 어긋나 누락된다. 멤버 행이 존재하면
  // 행 id 와 일치하도록 `mem:` id 를 emit 한다.
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
      .map((d) => {
        // 멤버 행이 있으면 행 id 가 mem: 이므로 recency 키도 mem: 로 맞춘다(dm→mem
        // fallback). 그래야 랭킹의 recentRank 가 실제 표시 행 id 와 일치한다.
        const memId = `mem:${d.otherUserId}`;
        return byId.has(memId) ? memId : `dm:${d.otherUserId}`;
      })
      .filter((id) => byId.has(id));
    return [...recentChannels, ...recentDms];
  }, [lruOrder, dms, byId]);

  // ── 표시할 행 계산 ────────────────────────────────────────────────────────
  const rows = useMemo<QsRow[]>(() => {
    const raw = query.trim();
    const prefix = raw.startsWith('#') ? '#' : raw.startsWith('@') ? '@' : '';
    const bare = prefix ? raw.slice(1) : raw;

    if (bare.length === 0 && !prefix) {
      // FR-KS-02: 기본 화면 — 최근 방문 5 + 읽지 않은 채널 상위 5.
      const recentRows = recentIds
        .map((id) => byId.get(id))
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

  const isEmpty = rows.length === 0;
  // 기본 화면(쿼리 비어 있음) 여부 — announce 타이밍 분기에 쓴다.
  const queryIsBlank = query.trim() === '';

  // FR-KS-01 + S82a fix-forward (a11y #4/#8): 결과 수 스크린리더 공지(공유 announcer).
  //  - 기본 화면(쿼리 비어 있음)에서는 Dialog 제목 낭독과 충돌하므로 건너뛴다.
  //  - 0건 + 쿼리가 비어 있지 않으면 빈 상태 안내를 공지한다.
  //  - 그 외에는 결과 수를 공지한다.
  useEffect(() => {
    if (queryIsBlank) return;
    if (isEmpty) {
      announce('검색 결과가 없습니다. Ctrl+N 으로 새 DM 을 시작하거나 채널을 둘러보세요');
    } else {
      announce(`${rows.length}개 결과`);
    }
  }, [queryIsBlank, isEmpty, rows.length]);

  // LOW-1: 언마운트(닫힘) 시 stale 공지를 200ms 뒤 비워 재낭독을 막는다(공유
  // announcer 프로토콜).
  useEffect(() => {
    return () => {
      announce('', { resetDelayMs: 200 });
    };
  }, []);

  function go(row: QsRow): void {
    if (row.target.kind === 'channel') {
      if (slug) navigate(`/w/${slug}/${row.target.channelName}`);
    } else {
      navigate(`/dm/${row.target.userId}`);
    }
    setOpenModal(null);
  }

  const listboxId = 'quick-switcher-listbox';
  const optionId = (i: number): string => `quick-switcher-option-${i}`;
  // a11y #1/#5: 빈 상태(listbox DOM 제거)에서는 controls/activedescendant 를 가질
  // 대상이 없으므로 명시적으로 undefined 로 둔다(aria-expanded 와 일관).
  const hasListbox = !isEmpty && rows.length > 0;
  const activeId = hasListbox ? optionId(focusIdx) : undefined;

  return (
    <Dialog
      open
      onOpenChange={(v) => setOpenModal(v ? 'quick-switcher' : null)}
      title="채널/멤버/DM 이동"
      description="이름을 입력해 채널·멤버·DM 으로 빠르게 이동합니다."
      className="max-w-lg"
    >
      <Input
        data-testid="quick-switcher-input"
        // a11y #10: Dialog 제목("채널/멤버/DM 이동")과 중복되지 않도록 입력은
        // 별도의 접근명을 갖는다(제목=대화상자 컨텍스트, 입력=검색 동작).
        aria-label="채널·멤버·DM 검색"
        autoFocus
        placeholder="채널 · 멤버 · DM 검색 (# 채널만, @ 멤버/DM만)"
        role="combobox"
        aria-autocomplete="list"
        // a11y #1: 빈 상태에서는 listbox DOM 이 없으므로 expanded=false 로 모순을
        // 없앤다(항상 true 였음). listbox 가 떠 있을 때만 true.
        aria-expanded={hasListbox}
        // a11y #5: listbox 가 없으면 controls/activedescendant 도 명시적 undefined.
        aria-controls={hasListbox ? listboxId : undefined}
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
          // a11y #2 (근거 주석): 항목 이동에 Tab/Shift+Tab 을 ArrowDown/Up 과 함께
          // 묶는다 — PRD FR-KS-03 이 "↑/↓/Tab 항목 이동"을 명시하기 때문이다. 이는
          // WCAG 2.1.2(키보드 트랩)에 어긋나지 않는다: Esc 가 키보드 닫기(escape
          // route)를 제공하고, 헤더의 X 버튼이 마우스 닫기를 제공한다. auditor 의
          // "Tab 으로 닫기 버튼 이동" 권고는 PRD 의 Tab=항목이동 정의와 충돌하므로
          // 채택하지 않는다(Tab=항목이동 · Esc=키보드 닫기 · X=마우스 닫기).
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
          {rows.map((row, i) => {
            const selected = i === focusIdx;
            return (
              <li
                key={row.item.id}
                id={optionId(i)}
                role="option"
                aria-selected={selected}
                // a11y #6+#9: 종류를 SR 이 알도록 단일 aria-label 부여. 내부 시각
                // span(접두 #/@ · meta)은 aria-hidden 으로 중복 낭독을 막는다.
                aria-label={`${KIND_LABEL[row.item.kind]}: ${row.item.label}${
                  row.meta ? `, ${row.meta}` : ''
                }`}
                data-testid={`quick-switcher-item-${i}`}
                data-kind={row.item.kind}
                // a11y #6: 비색 선택 인디케이터. 색(배경) 단독 의존을 피해 선택 행에
                // 좌측 강조 border + outline 을 함께 둔다(app-layer index.css 의
                // [data-qs-active] 규칙). DS --bg-selected 대비 검증은 DS-owner 이월.
                data-qs-active={selected ? 'true' : undefined}
                onMouseEnter={() => setFocusIdx(i)}
                onClick={() => go(row)}
                className="qf-menu__item justify-between"
                style={{
                  background: selected ? 'var(--bg-selected)' : 'transparent',
                  color: selected ? 'var(--text-strong)' : 'var(--text-secondary)',
                }}
              >
                <span aria-hidden="true">
                  <span className="text-text-muted">
                    {row.item.kind === 'channel' ? '# ' : '@ '}
                  </span>
                  {row.item.label}
                </span>
                {row.meta ? (
                  <span aria-hidden="true" className="qf-menu__kbd">
                    {row.meta}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}
