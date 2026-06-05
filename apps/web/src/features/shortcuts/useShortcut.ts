import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useUI } from '../../stores/ui-store';
import { useMyWorkspaces } from '../workspaces/useWorkspaces';
import { useChannelList } from '../channels/useChannels';
import { useMarkAllRead, useUnreadSummary } from '../channels/useUnread';
import { classifyReadShortcut } from './readShortcut';
import { searchPrefillQuery } from './searchPrefill';
import { announce } from '../../lib/a11y-announce';

type Combo = {
  key: string;
  ctrlOrMeta?: boolean;
  shift?: boolean;
  alt?: boolean;
};

function matches(e: KeyboardEvent, c: Combo): boolean {
  const wantCtrl = c.ctrlOrMeta ?? false;
  const pressedCtrl = e.ctrlKey || e.metaKey;
  return (
    e.key.toLowerCase() === c.key.toLowerCase() &&
    wantCtrl === pressedCtrl &&
    Boolean(c.shift) === e.shiftKey &&
    Boolean(c.alt) === e.altKey
  );
}

function inInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * App-level shortcuts. Bound ONCE on mount (inside Shell), so every route
 * inside the shell gets the same keymap without prop-drilling.
 * Shortcuts that must work inside an input (Escape to close overlays)
 * opt-in via the `force` flag on the match function.
 */
export function useGlobalShortcuts(): void {
  const navigate = useNavigate();
  const { slug, channelName } = useParams<{ slug: string; channelName?: string }>();
  const setOpenModal = useUI((s) => s.setOpenModal);
  const openModal = useUI((s) => s.openModal);
  // S31 (FR-S12): Ctrl/Cmd+F → 현재 채널 in: 프리필 검색 패널.
  const openSearchPanel = useUI((s) => s.openSearchPanel);
  const { data: mine } = useMyWorkspaces();
  const currentWorkspaceId = mine?.workspaces.find((w) => w.slug === slug)?.id;
  const { data: channels } = useChannelList(currentWorkspaceId);
  // S23 (FR-RS-11): Shift+Esc = 워크스페이스 전체 읽음. 현재 워크스페이스
  // scope 로 bulk read-all 을 발화한다.
  const markAllRead = useMarkAllRead(currentWorkspaceId);
  // S82b (FR-KS-04): Alt+Shift+↑/↓ 미읽 채널 순회용 요약. 사이드바와 동일한
  // 권위 캐시를 공유 구독한다(조건부 호출 금지 — 훅 규칙 준수, slug 없을 때는
  // currentWorkspaceId 가 undefined 라 useQuery enabled:false 로 idle).
  const { data: unreadSummary } = useUnreadSummary(currentWorkspaceId);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const inputActive = inInput(e.target);

      // Escape: always close overlays (works even in inputs so you can bail
      // out of a dialog).
      if (e.key === 'Escape' && openModal) {
        setOpenModal(null);
        return;
      }

      // S23 (FR-RS-11): Esc=현재 채널 읽음 / Shift+Esc=전체 읽음. 모달이 위에서
      // 이미 처리됐고, 입력 필드 포커스 중에는 classify 가 none 을 돌려 기존 Esc
      // 동작(컴포저 자동완성 닫기/포커스 해제)을 무회귀로 둔다.
      //
      // S23 BLOCKER fix (이중 방어): EmojiPicker/ThreadPanel/SearchInput 같은
      // 오버레이가 Esc 를 소비하면 e.preventDefault()(+ stopPropagation)를
      // 호출한다. 그 오버레이의 window 리스너가 먼저 실행돼 defaultPrevented 가
      // 켜졌다면 read 단축키를 skip 해 채널이 강제 읽음 처리되지 않게 한다.
      if (e.defaultPrevented) return;
      const readAction = classifyReadShortcut(e, { inputActive, modalOpen: openModal !== null });
      if (readAction === 'mark-current') {
        e.preventDefault();
        // 현재 채널의 최신 메시지까지 읽음 — AckScheduler 를 보유한 MessageColumn 에
        // CustomEvent 로 위임한다(검색/컴포저 포커스와 동일한 dispatch 패턴).
        window.dispatchEvent(new CustomEvent('qufox.read.current'));
        announce('현재 채널을 읽음으로 표시했습니다');
        return;
      }
      if (readAction === 'mark-all') {
        e.preventDefault();
        if (currentWorkspaceId) {
          markAllRead.mutate();
          announce('워크스페이스의 모든 채널을 읽음으로 표시했습니다');
        }
        return;
      }

      if (inputActive) return;

      // S82a (FR-KS-01): Ctrl/Cmd + Shift + K → 액션 팰릿(CommandPalette). 종전
      // 단축 Cmd+K 는 신규 퀵스위처(채널/멤버/DM 이동)로 넘어갔고, 기존 액션
      // 팰릿은 충돌을 피해 Shift 조합으로 재바인딩한다(동작 자체는 보존). Shift
      // 분기를 비-Shift 분기보다 먼저 검사해, matches 의 정확한 Shift 매칭이
      // Cmd+K 와 갈리도록 한다.
      if (matches(e, { key: 'k', ctrlOrMeta: true, shift: true })) {
        e.preventDefault();
        setOpenModal(openModal === 'command-palette' ? null : 'command-palette');
        return;
      }

      // S82a (FR-KS-01): Ctrl/Cmd + K → 퀵스위처(채널/멤버/DM 퍼지 이동).
      if (matches(e, { key: 'k', ctrlOrMeta: true })) {
        e.preventDefault();
        setOpenModal(openModal === 'quick-switcher' ? null : 'quick-switcher');
        return;
      }

      // S83c (FR-KS-09): Ctrl/Cmd + / → 단축키 치트시트 오버레이.
      // PRD FR-KS-09 는 이 조합을 단축키 오버레이로 지정한다(`?` 와 동일 동작 —
      // 의도적 중복: 물리 키보드는 `Cmd+/`, 텍스트 입력 외 맥락은 `?`).
      // 종전(task-015-C)엔 인라인 topbar 검색 포커스를 발화했으나, 검색 진입은
      // 토픽바 입력 클릭 + CommandPalette 검색 액션 + Ctrl/Cmd+F(현재 채널 검색)로
      // 충분히 보존되므로 전용 단축키를 제거하고 치트시트로 양보한다.
      if (matches(e, { key: '/', ctrlOrMeta: true })) {
        e.preventDefault();
        setOpenModal(openModal === 'shortcut-help' ? null : 'shortcut-help');
        return;
      }

      // S31 (FR-S12 + reviewer NIT5/DM): Ctrl/Cmd + F → 현재 채널 로컬 검색.
      //  - 모달이 열려 있으면 가로채지 않는다(브라우저 기본 찾기 유지) — 모달
      //    위에서 단축키가 패널을 띄우면 맥락이 어긋난다.
      //  - in:#<채널> 프리필은 실제 텍스트성 채널일 때만 적합하다. DM/그룹 DM
      //    은 #채널 이름이 없으므로(in:#<userId> 는 부적합) 빈 패널을 연다.
      //  - 현재 채널이 없으면(워크스페이스 루트) 브라우저 기본 찾기를 둔다.
      if (matches(e, { key: 'f', ctrlOrMeta: true }) && channelName && !openModal) {
        const flat = channels
          ? [...channels.uncategorized, ...channels.categories.flatMap((c) => c.channels)]
          : [];
        const current = flat.find((c) => c.name === channelName);
        e.preventDefault();
        // 텍스트성 채널만 in:#name 프리필. DM/그룹 DM/미해결 채널은 빈 패널.
        openSearchPanel(searchPrefillQuery(channelName, current?.type));
        return;
      }

      // `?` (Shift+/ on US layout) → shortcut help. No Ctrl. In-input
      // guard above already blocks this inside textareas/inputs.
      if (e.key === '?') {
        e.preventDefault();
        setOpenModal(openModal === 'shortcut-help' ? null : 'shortcut-help');
        return;
      }

      // S82b (FR-KS-04): Alt + Shift + ↑/↓ → 미읽 채널 순회. 비-Shift Alt+↑/↓
      // (아래 채널 순회)보다 **먼저** 검사해야 한다 — Shift 정확 매칭으로 둘이
      // 교차 발화하지 않게 한다(Cmd+Shift+K vs Cmd+K 선례와 동일한 가드).
      //
      // 정렬: 사이드바 flat 순서(uncategorized + categories.flatMap)를 그대로
      // 따라 사용자의 멘탈 모델과 일치시키고, 그 순서에서 unreadCount > 0 인
      // 채널만 추린다(서버 lastMessageAt 정렬이 아니라 시각적 채널 순서 우선).
      // 현재 채널 기준 다음(↓)/이전(↑) 미읽으로 wrap-around 이동하고, 현재
      // 채널이 미읽 목록에 없으면 첫 미읽로 점프한다. 미읽 0개면 no-op.
      // DM 미읽 순회는 OUT(FR-KS-04 는 "미읽 채널"만) — workspace 채널만 대상.
      if (
        (e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
        e.altKey &&
        e.shiftKey &&
        slug &&
        channels
      ) {
        const flat = [...channels.uncategorized, ...channels.categories.flatMap((c) => c.channels)];
        const unreadIds = new Set(
          (unreadSummary?.channels ?? []).filter((c) => c.unreadCount > 0).map((c) => c.channelId),
        );
        const unreadChannels = flat.filter((c) => unreadIds.has(c.id));
        if (unreadChannels.length === 0) return;
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        const currentIdx = unreadChannels.findIndex((c) => c.name === channelName);
        // 현재 채널이 미읽 목록에 없으면(-1) 첫 미읽로. 있으면 다음/이전으로 wrap.
        const nextIdx =
          currentIdx < 0 ? 0 : (currentIdx + step + unreadChannels.length) % unreadChannels.length;
        const target = unreadChannels[nextIdx];
        // a11y(#3): SPA navigate 는 SR 에 페이지 전환을 자동 통지하지 않으므로(S81a MAJ-5
        // cross-cutting 이월) 이동 대상 채널명을 공유 announcer 로 공지한다.
        announce(`${target.name} 채널로 이동했습니다 (미읽)`);
        navigate(`/w/${slug}/${target.name}`);
        return;
      }

      // Alt + ↑/↓: previous/next channel in current workspace.
      // S82b LOW-2: !e.shiftKey 로 Alt+Shift+Arrow(미읽순회)와의 상호배제를 분기 순서가
      // 아니라 구조적으로 보장한다(향후 분기 재정렬에도 cross-fire 방지).
      if (
        (e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
        e.altKey &&
        !e.shiftKey &&
        slug &&
        channels
      ) {
        const flat = [...channels.uncategorized, ...channels.categories.flatMap((c) => c.channels)];
        if (flat.length === 0) return;
        const currentIdx = flat.findIndex((c) => c.name === channelName);
        const step = e.key === 'ArrowDown' ? 1 : -1;
        const nextIdx = currentIdx < 0 ? 0 : (currentIdx + step + flat.length) % flat.length;
        e.preventDefault();
        const target = flat[nextIdx];
        announce(`${target.name} 채널로 이동했습니다`);
        navigate(`/w/${slug}/${target.name}`);
        return;
      }

      // Ctrl/Cmd + Shift + A: cycle workspaces
      if (
        matches(e, { key: 'a', ctrlOrMeta: true, shift: true }) &&
        mine &&
        mine.workspaces.length > 0
      ) {
        const list = mine.workspaces;
        const idx = list.findIndex((w) => w.slug === slug);
        const next = list[(idx + 1) % list.length];
        e.preventDefault();
        navigate(`/w/${next.slug}`);
        return;
      }

      // S82b (FR-KS-11): Ctrl/Cmd + N → 새 DM 시작. friends list 가 새 DM 진입점
      // 이므로 /friends 로 이동한다(S82a 빈상태 힌트의 실제 배선). inputActive
      // 가드는 위에서 이미 통과했다.
      //
      // CAVEAT: 다수 브라우저가 Ctrl+N 을 "새 창" 으로 예약해 두어, 일부 환경
      // 에서는 keydown 이 페이지로 전달되기 전에 가로채여 preventDefault 가 먹지
      // 않을 수 있다(best-effort). 이 경우 빈상태의 힌트가 대체 안내를 제공한다.
      if (matches(e, { key: 'n', ctrlOrMeta: true })) {
        e.preventDefault();
        navigate('/friends');
        return;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    navigate,
    slug,
    channelName,
    channels,
    mine,
    setOpenModal,
    openModal,
    openSearchPanel,
    currentWorkspaceId,
    markAllRead,
    unreadSummary,
  ]);
}
