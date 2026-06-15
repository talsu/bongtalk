import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MessageDto, ThreadNotificationLevel, WorkspaceRole } from '@qufox/shared-types';
import { useMembers, useWorkspace } from '../workspaces/useWorkspaces';
import {
  Avatar,
  DropdownContent,
  DropdownRadioGroup,
  DropdownRadioItem,
  DropdownRoot,
  DropdownTrigger,
  Icon,
} from '../../design-system/primitives';
import { useCompose, threadDraftKey } from '../../stores/compose-store';
import { roleBadgeLabel } from '../messages/roleBadge';
import { renderMessageContent } from '../messages/parseContent';
// 072-N0 (감사 D04 · mock 5941): 스레드 패널 루트/답글 본문을 메인 타임라인과
// 동일하게 커스텀 이모지까지 리치 렌더하기 위한 룩업 컨텍스트. ★리뷰 MEDIUM:
// 컨텍스트(쿼리 훅 아님 — 테스트 하니스 안전)를 쓰고, 실제 provider 는 마운트
// 지점(MessageColumn/MobileMessages)이 CustomEmojiProvider 로 감싼다.
import { useCustomEmojiLookup } from '../emojis/CustomEmojiContext';
import type { CustomEmoji } from '../emojis/api';
import { cn } from '../../lib/cn';
import {
  useThreadReplies,
  useSendReply,
  useAckThread,
  useSetThreadLock,
  useSetThreadNotificationLevel,
} from './useThread';

type Props = {
  workspaceId: string;
  channelId: string;
  channelName?: string;
  rootId: string;
  onClose: () => void;
  // S35 (FR-TH-05): 모바일(768px 미만) 전체화면 모드. DS 에 `qf-m-panel-thread`
  // 정의가 없어(mobile.css 미등록) app-layer 전체화면 레이아웃을 합성한다(DS 무수정).
  // 헤더의 닫기 버튼이 back 화살표로 바뀌고 패널이 fixed inset-0 으로 깔린다.
  // 데스크톱(기본 false)은 기존 `qf-thread-panel` 320/420px 고정 폭 그대로.
  mobile?: boolean;
};

/**
 * S38 fix-forward (a11y B-01/B-02): 알림 레벨의 사람이 읽는 한국어 라벨. 벨 트리거
 * aria-label("스레드 알림 설정: …")과 드롭다운 항목 텍스트가 공유하는 단일 출처다.
 */
function notifLevelLabel(level: ThreadNotificationLevel): string {
  return level === 'ALL' ? '모든 답글' : level === 'MENTIONS' ? '멘션만' : '알림 끔';
}

/**
 * Task-014-C + design-system v2 refresh: right-side thread panel
 * rebuilt on the DS `qf-thread-panel` primitives (see
 * /design-system/index.html § Thread). Header → pinned origin card →
 * day divider → compact `qf-thread-msg` rows → `qf-thread-composer`.
 *
 * S35 (FR-TH-05): `mobile` 플래그로 동일 로직(useThreadReplies/useSendReply/
 * ESC/scroll/jump/broadcast)을 재사용하면서 모바일 전체화면 레이아웃을 입힌다.
 */
export function ThreadPanel({
  workspaceId,
  channelId,
  channelName,
  rootId,
  onClose,
  mobile = false,
}: Props): JSX.Element | null {
  const { data: members } = useMembers(workspaceId);
  // 072-N0 (감사 D04) + 리뷰 MEDIUM: 커스텀 이모지 룩업(컨텍스트). 종전엔 ThreadPanel
  // 이 CustomEmojiProvider 바깥의 형제라 빈 맵 → :slug: 평문 깨짐이었다. 수리는
  // ThreadPanel 마운트 지점(MessageColumn 데스크톱 / MobileMessages 모바일)을
  // CustomEmojiProvider 로 감싸 처리한다(여기선 컨텍스트 소비만 — 쿼리 훅 미사용).
  const customEmojis = useCustomEmojiLookup();
  // S38 (FR-TH-13): 본인의 워크스페이스 역할(OWNER/ADMIN 만 잠금/해제 + 잠긴
  // 스레드 답글 가능). useWorkspace 의 myRole 을 단일 출처로 쓴다.
  const { data: wsData } = useWorkspace(workspaceId);
  const myRole: WorkspaceRole = wsData?.myRole ?? 'MEMBER';
  const isModerator = myRole === 'OWNER' || myRole === 'ADMIN';
  const history = useThreadReplies(rootId);
  const reply = useSendReply(workspaceId, channelId, rootId);
  // S36 (FR-RS-12 / FR-TH-12): 읽음 ACK. mount/최하단 스크롤 시 디바운스 호출.
  const ackThread = useAckThread(workspaceId, channelId, rootId);
  // S38 (FR-TH-08): 알림 레벨 설정. 벨 드롭다운 로컬 상태 + 서버 upsert.
  const setLevel = useSetThreadNotificationLevel(rootId);
  // S38 (FR-TH-13): 잠금/해제(OWNER/ADMIN). 실시간 반영은 dispatcher 수신.
  const setLock = useSetThreadLock(rootId);
  // 벨 드롭다운의 표시 레벨(낙관적). 서버 round-trip 완료를 기다리지 않고 즉시 갱신.
  // 초기값은 'ALL' 이되, GET 응답의 viewerNotificationLevel 로 hydrate 한다(아래
  // useEffect) — 저장된 OFF/MENTIONS 가 무시되던 회귀를 막는다(reviewer MAJOR).
  const [notifLevel, setNotifLevel] = useState<ThreadNotificationLevel>('ALL');
  // 사용자가 벨로 직접 레벨을 바꿨는지 추적. true 면 GET refetch 가 와도 서버값으로
  // 덮어쓰지 않는다(낙관적 갱신 보존 — 사용자 액션이 우선). 패널 재오픈/루트 변경
  // 시 다시 false 로 리셋되어 새 스레드의 저장된 레벨로 hydrate 된다.
  const userTouchedLevelRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // S35 fix-forward (a11y BLOCKER): 모바일 전체화면 패널은 role="dialog"
  // aria-modal 이므로 포커스 트랩 + mount 포커스 이동의 앵커가 필요하다.
  // panelRef 는 트랩 범위(패널 내 focusable 순환), backRef 는 mount 시
  // 최초 포커스 대상(back 버튼)이다. 데스크톱(mobile=false)에서는 트랩/
  // 자동 포커스 모두 비활성(기존 데스크톱 UX 무회귀).
  const panelRef = useRef<HTMLElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  // S35 (FR-TH-18): mount 시 1회 초기 스크롤이 끝났는지 추적. 첫 페이지가
  // 도착하기 전(replies 0)에는 스크롤 대상이 없으므로 첫 렌더 이후로 미룬다.
  const hasAnchoredRef = useRef(false);
  // S35 (FR-TH-18): thread reply 수신 시 near-bottom 이 아니면 노출되는 jump
  // 버튼 상태. 클릭 시 최하단으로 이동하고 숨긴다.
  const [showJump, setShowJump] = useState(false);
  // S38 fix-forward (a11y B-03): 잠금 상태 변경(thread:lock:changed 실시간 수신
  // 포함)을 스크린리더에 polite 으로 알리는 sr-only 메시지. 직전 locked 값을
  // 추적해 실제 토글 시에만 갱신한다(초기 mount 는 알리지 않는다).
  const [lockAnnounce, setLockAnnounce] = useState('');
  const prevLockedRef = useRef<boolean | null>(null);
  // S36 (FR-TH-12): ACK 디바운스 타이머. mount/스크롤-최하단 시 마지막 답글
  // id 로 ACK 를 보내되, 짧은 시간 내 중복 발화를 합친다(채널 ack 와 동일 패턴).
  const ackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pages = history.data?.pages ?? [];
  const root: MessageDto | undefined = pages[0]?.root;
  // S38 (FR-TH-13): 스레드 잠금 상태. 루트 DTO 의 threadLocked 를 단일 출처로
  // 쓴다. dispatcher 가 thread:lock:changed 수신 시 이 캐시의 루트를 갱신하므로
  // 실시간으로 반영된다(별도 로컬 상태 불필요).
  const locked = root?.threadLocked === true;
  const replies = useMemo<MessageDto[]>(() => pages.flatMap((p) => p.replies), [pages]);
  // S36 (FR-TH-18): viewer 의 스레드 읽음 커서(첫 페이지에만 의미). 초기 스크롤
  // 앵커 + ACK 디바운스의 기준점. 구 API 응답(필드 없음)은 null 폴백.
  const lastReadMessageId = pages[0]?.readState?.lastReadMessageId ?? null;
  // S38 fix-forward (reviewer MAJOR / FR-TH-08): GET 응답의 viewer 알림 레벨.
  // 미구독(서버 null)이거나 구 API 응답이면 'ALL' 로 표시한다(벨 기본 표기).
  const viewerLevel: ThreadNotificationLevel = pages[0]?.viewerNotificationLevel ?? 'ALL';

  // S38 fix-forward (FR-TH-08): 벨 hydration. 루트가 바뀌면(패널 재오픈/다른
  // 스레드) 사용자-수정 플래그를 리셋해 새 스레드의 저장된 레벨로 다시 seed 한다.
  useEffect(() => {
    userTouchedLevelRef.current = false;
  }, [rootId]);

  // GET 응답이 도착하면 서버의 저장된 레벨로 벨을 seed 한다. 단, 사용자가 이미
  // 벨로 직접 바꿨다면(userTouchedLevelRef) 그 낙관적 값을 보존한다.
  useEffect(() => {
    if (userTouchedLevelRef.current) return;
    setNotifLevel(viewerLevel);
  }, [viewerLevel]);

  // S38 fix-forward (a11y B-03): 잠금 토글 시 sr-only status 로 알린다.
  // dispatcher 의 thread:lock:changed 수신으로 루트 DTO(locked)가 바뀌면 여기서
  // 실시간으로 안내가 주입된다. 첫 mount(prev=null)는 알리지 않는다(상태 변화만).
  useEffect(() => {
    const prev = prevLockedRef.current;
    if (prev !== null && prev !== locked) {
      setLockAnnounce(locked ? '스레드가 잠겼습니다' : '스레드 잠금이 해제되었습니다');
    }
    prevLockedRef.current = locked;
  }, [locked]);

  // S36 (FR-TH-12): 마지막(최신) 비삭제 답글 id 까지 ACK 한다(디바운스 600ms).
  // ThreadReadState 가 그 답글까지 monotonic 전진 → 스레드 unread dot 이 꺼진다.
  const ackUpToLatest = useMemo(() => {
    return (): void => {
      const last = replies[replies.length - 1];
      // optimistic(tmp-) 행은 서버 row 가 아직 없으므로 ack 대상에서 제외한다.
      if (!last || last.id.startsWith('tmp-')) return;
      if (ackTimerRef.current) clearTimeout(ackTimerRef.current);
      ackTimerRef.current = setTimeout(() => {
        ackThread.mutate(last.id);
      }, 600);
    };
    // ackThread.mutate 는 안정적(react-query)이며 replies 길이/마지막 id 변화에만
    // 의존한다(이 repo 는 react-hooks/exhaustive-deps 규칙 미설치 — disable 불필요).
  }, [replies]);

  const nameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of members?.members ?? []) map.set(m.userId, m.user.username);
    return map;
  }, [members]);

  const roleById = useMemo(() => {
    const map = new Map<string, WorkspaceRole>();
    for (const m of members?.members ?? []) map.set(m.userId, m.role);
    return map;
  }, [members]);

  // S36 (FR-TH-18): mount 시 초기 스크롤(1회). 첫 페이지(root + replies)가
  // 그려진 직후 useLayoutEffect 로 페인트 전에 앵커한다.
  //   - ThreadReadState.lastReadMessageId 가 존재하고 그 다음 첫 읽지 않음 답글이
  //     현재 로드된 페이지 안에 있으면, 그 읽지 않음 답글로 스크롤한다(읽던 위치 복원).
  //   - 커서가 없거나(전체 읽지 않음) lastRead 가 최신(읽지 않음 0)이거나 읽지 않음 답글이 아직
  //     로드 안 됐으면 최하단으로 스크롤한다(기존 S35 동작).
  // hasAnchoredRef 충돌 방지: 이 초기 스크롤은 anchored=false 일 때 1회만 수행하고
  // 즉시 true 로 잠근다(이후 새 답글 자동 스크롤 effect 와 경쟁하지 않음).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || hasAnchoredRef.current) return;
    if (replies.length === 0 && !root) return; // 그릴 게 아직 없음 — 다음 렌더로 미룸.

    let anchored = false;
    if (lastReadMessageId) {
      const lastReadIdx = replies.findIndex((r) => r.id === lastReadMessageId);
      // 다음 첫 읽지 않음 답글 = lastRead 직후. 존재하면 그 행으로 스크롤.
      const firstUnread = lastReadIdx >= 0 ? replies[lastReadIdx + 1] : undefined;
      if (firstUnread) {
        const target = el.querySelector<HTMLElement>(
          `[data-testid="thread-reply-${firstUnread.id}"]`,
        );
        if (target) {
          // 읽지 않음 답글이 뷰 상단에 오도록(읽기 시작 위치) 정렬.
          target.scrollIntoView({ block: 'start' });
          anchored = true;
        }
      }
    }
    if (!anchored) {
      // 커서 없음 / 읽지 않음 0 / 읽지 않음 답글 미로드 → 최하단(기존 S35 동작).
      el.scrollTop = el.scrollHeight;
    }
    hasAnchoredRef.current = true;
    // 초기 앵커 직후 한 번 ACK — 패널을 열어 본 시점까지 읽음 처리(디바운스).
    ackUpToLatest();
  }, [replies, root, lastReadMessageId, ackUpToLatest]);

  // S35 (FR-TH-18): thread reply 수신 시 — 이미 near-bottom(<80px)이면 자동
  // 스크롤하고, 아니면 jump 버튼을 노출한다(사용자가 위쪽 이력을 읽는 중이면
  // 강제로 끌어내리지 않는다). 초기 mount 앵커가 끝난 뒤에만 동작한다.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !hasAnchoredRef.current) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (near) {
      el.scrollTop = el.scrollHeight;
      setShowJump(false);
      // S36 (FR-TH-12): 최하단 상태에서 새 답글이 도착하면 자동으로 읽음 ACK.
      ackUpToLatest();
    } else {
      setShowJump(true);
    }
    // replies.length 만 의존(ackUpToLatest 는 replies 파생이라 동반 변화).
    // 이 repo 는 react-hooks/exhaustive-deps 규칙 미설치 — disable 주석 불필요.
  }, [replies.length]);

  // S35 (FR-TH-18): 사용자가 수동으로 최하단까지 스크롤하면 jump 버튼을 숨긴다.
  // S36 (FR-TH-12): 최하단 도달 시 읽음 ACK(디바운스 — 스크롤 연타 안전).
  const onBodyScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (near) {
      if (showJump) setShowJump(false);
      ackUpToLatest();
    }
  };

  const jumpToBottom = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setShowJump(false);
    // S36 (FR-TH-12): jump 로 최신까지 이동 → 읽음 ACK.
    ackUpToLatest();
  };

  // S36 (FR-TH-12): 언마운트 시 대기 중인 ACK 타이머 정리(메모리 누수/지연 발화 방지).
  useEffect(() => {
    return () => {
      if (ackTimerRef.current) clearTimeout(ackTimerRef.current);
    };
  }, []);

  // ESC closes the panel — scoped to this panel's mount lifetime.
  // S23 BLOCKER fix: Esc 가 스레드 패널을 닫는 데 소비되면 전파/기본동작을
  // 멈춰 useGlobalShortcuts 의 read 단축키(mark-current)가 같은 Esc 로 동시
  // 발화하지 않게 한다(채널 강제 읽음 방지).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // S35 fix-forward (a11y BLOCKER): 모바일 dialog mount 시 back 버튼으로 포커스를
  // 옮긴다(스크린리더가 패널 진입을 인지하고, 키보드 사용자가 패널 안에서 시작).
  // 데스크톱은 인라인 패널이라 포커스 이동을 하지 않는다(기존 UX 유지).
  useEffect(() => {
    if (!mobile) return;
    // back 버튼이 우선, 없으면 textarea 로 폴백(둘 다 mount 직후 존재).
    const target =
      backRef.current ??
      panelRef.current?.querySelector<HTMLElement>('[data-testid="thread-input"]') ??
      null;
    target?.focus();
  }, [mobile]);

  // S35 fix-forward (a11y BLOCKER): 모바일 dialog 포커스 트랩. Tab/Shift+Tab 이
  // 패널 내 focusable 요소를 순환하게 해 배경(채널 목록)으로 포커스가 새지 않게
  // 한다. ESC 닫기는 위 별도 effect 가 처리한다. 데스크톱은 트랩 없음.
  useEffect(() => {
    if (!mobile) return;
    const onTab = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button:not([disabled]):not([hidden]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    const panel = panelRef.current;
    panel?.addEventListener('keydown', onTab);
    return () => panel?.removeEventListener('keydown', onTab);
  }, [mobile]);

  if (!rootId) return null;

  const rootAuthorName = root ? (nameById.get(root.authorId) ?? 'unknown') : '';
  const rootBadge = root ? roleBadgeLabel(roleById.get(root.authorId) ?? null) : null;

  return (
    // S35 (FR-TH-05/18): 데스크톱은 DS `qf-thread-panel`(320/420px 고정 폭) +
    // jump 버튼 앵커용 `relative`. 모바일은 DS 미등록(qf-m-panel-thread 부재)이라
    // app-layer 전체화면(fixed inset-0 z-[var(--z-modal)] + DS 토큰 배경/세이프
    // 에어리어)을 합성한다 — DS 파일 무수정. 두 경우 모두 내부 로직/마크업 동일.
    <aside
      ref={panelRef}
      data-testid="thread-panel"
      data-variant={mobile ? 'mobile' : 'desktop'}
      aria-label="스레드"
      // S35 fix-forward (a11y BLOCKER): 모바일 전체화면 패널은 배경을 가리는
      // 모달이므로 role="dialog" aria-modal 로 스크린리더에 모달임을 알린다.
      // 데스크톱은 사이드 패널(비모달)이라 role 을 부여하지 않는다(landmark
      // aside 유지).
      role={mobile ? 'dialog' : undefined}
      aria-modal={mobile ? true : undefined}
      className={cn(
        'relative',
        mobile
          ? 'fixed inset-0 z-[var(--z-modal)] flex flex-col qf-m-safe-bottom'
          : 'qf-thread-panel',
      )}
      style={mobile ? { background: 'var(--bg-chat)' } : undefined}
    >
      <header className={cn('qf-thread-panel__header', mobile ? 'qf-m-safe-top' : undefined)}>
        {mobile ? (
          // S35 (FR-TH-05): 모바일 back 버튼(ESC 대체). 데스크톱은 닫기(x).
          <button
            ref={backRef}
            type="button"
            data-testid="thread-back"
            onClick={onClose}
            // A-09: 모바일 back 버튼은 스레드 패널을 닫는 동작이므로 "스레드 닫기"로
            // 명시한다(데스크톱 닫기 버튼 aria-label 과 의미 통일).
            aria-label="스레드 닫기"
            className="qf-thread-panel__close"
            style={{ minWidth: 'var(--m-touch)', minHeight: 'var(--m-touch)' }}
          >
            <Icon name="chevron-left" size="sm" />
          </button>
        ) : (
          <Icon name="thread" size="sm" className="qf-thread-panel__icon" />
        )}
        <div className="min-w-0 flex-1">
          <div className="qf-thread-panel__title">
            스레드
            {/* S38 (FR-TH-13): 잠금 표식. 잠긴 스레드에 잠금 아이콘(#qf-i-lock)을
                제목 옆에 노출한다. DS 등록 아이콘만 사용(신규 DS 0).
                a11y #9: 아이콘은 aria-hidden — 잠금 상태는 부모 heading 의 sr-only
                "(잠김)" 텍스트가 전달한다(아이콘+sr-only 텍스트 이중 노출 방지). */}
            {locked ? (
              <>
                <Icon
                  name="lock"
                  size="sm"
                  aria-hidden
                  data-testid="thread-lock-indicator"
                  className="qf-icon--muted ml-[var(--s-2)] inline-block align-middle"
                />
                <span className="sr-only">(잠김)</span>
              </>
            ) : null}
          </div>
          <div className="qf-thread-panel__sub">
            {channelName ? `#${channelName}` : ''}
            {root?.thread?.replyCount ? ` · ${root.thread.replyCount}개의 답글` : ''}
          </div>
        </div>

        {/* S38 (FR-TH-13/08): 헤더 우측 액션 그룹(벨/잠금/닫기). 각 버튼에 ml-auto 를
            중복으로 거는 대신, 그룹 컨테이너 하나만 ml-auto 로 우측 정렬한다(S38
            DS-fix #8 — `__close` margin-left:auto 3중 적용 레이아웃 위험 제거). */}
        <div className="ml-auto flex items-center gap-[var(--s-1)]">
          {/* S38 (FR-TH-08): 알림 레벨 벨 드롭다운(ALL/MENTIONS/OFF). 기존 DS
              DropdownRoot/Trigger/Content primitive 재사용 — 신규 DS 0. 구독
              없던 사용자도 여기서 ALL 로 수동 구독된다(서버 upsert).
              a11y(B-01/B-02): RadioGroup/RadioItem(role=menuitemradio +
              aria-checked)으로 현재 선택을 SR 에 노출 + 트리거 aria-label 에 현재
              레벨 반영. */}
          <DropdownRoot>
            <DropdownTrigger asChild>
              <button
                type="button"
                data-testid="thread-notif-bell"
                aria-haspopup="menu"
                aria-label={`스레드 알림 설정: ${notifLevelLabel(notifLevel)}`}
                className="qf-thread-panel__close"
              >
                <Icon name={notifLevel === 'OFF' ? 'bell-off' : 'bell'} size="sm" />
              </button>
            </DropdownTrigger>
            <DropdownContent align="end">
              <DropdownRadioGroup
                value={notifLevel}
                onValueChange={(v) => {
                  const lvl = v as ThreadNotificationLevel;
                  // 사용자가 직접 바꾼 값은 GET refetch hydration 이 덮어쓰지 않는다.
                  userTouchedLevelRef.current = true;
                  setNotifLevel(lvl);
                  setLevel.mutate(lvl);
                }}
              >
                {(['ALL', 'MENTIONS', 'OFF'] as const).map((lvl) => (
                  <DropdownRadioItem key={lvl} value={lvl}>
                    <span data-testid={`thread-notif-${lvl}`}>{notifLevelLabel(lvl)}</span>
                  </DropdownRadioItem>
                ))}
              </DropdownRadioGroup>
            </DropdownContent>
          </DropdownRoot>

          {/* S38 (FR-TH-13): OWNER/ADMIN 잠금/해제 토글. MEMBER 이하는 버튼 미노출
              (잠금 아이콘 표식만 본다). 잠금 시 lock, 해제 가능 시도 동일 아이콘 +
              aria-label 로 의도 구분. aria-busy 로 진행 중 상태를 SR 에 전달. */}
          {isModerator ? (
            <button
              type="button"
              data-testid="thread-lock-toggle"
              onClick={() => setLock.mutate(!locked)}
              aria-label={locked ? '스레드 잠금 해제' : '스레드 잠그기'}
              aria-busy={setLock.isPending}
              className="qf-thread-panel__close"
            >
              <Icon name="lock" size="sm" className={locked ? undefined : 'qf-icon--muted'} />
            </button>
          ) : null}

          {mobile ? null : (
            <button
              type="button"
              data-testid="thread-close"
              onClick={onClose}
              aria-label="스레드 닫기"
              className="qf-thread-panel__close"
            >
              <Icon name="x" size="sm" />
            </button>
          )}
        </div>
      </header>

      {/* S38 fix-forward (a11y B-03): 잠금 상태 변경 sr-only live region. 시각
          레이아웃 무영향 — 스크린리더에만 "스레드가 잠겼습니다 / 잠금이
          해제되었습니다" 를 polite 으로 전달한다. */}
      <div role="status" aria-live="polite" className="sr-only" data-testid="thread-lock-announce">
        {lockAnnounce}
      </div>

      <div
        ref={scrollRef}
        data-testid="thread-body"
        className="qf-thread-body"
        onScroll={onBodyScroll}
      >
        {root ? (
          <div data-testid="thread-root" className="qf-thread-origin">
            <div className="qf-thread-origin__meta">
              <span className="qf-thread-origin__author">{rootAuthorName}</span>
              {rootBadge ? <span className="qf-badge qf-badge--accent">{rootBadge}</span> : null}
              <span className="qf-thread-origin__time">
                {new Date(root.createdAt).toLocaleTimeString()}
              </span>
            </div>
            {/* 072-N0 (감사 D04 · mock 5941): 루트 본문도 답글과 동일하게
               mrkdwn + 커스텀 이모지 리치 렌더(이전엔 plain text 였음). */}
            <div className="qf-thread-origin__body">
              {renderMessageContent(root.content ?? '', customEmojis.byName)}
            </div>
          </div>
        ) : history.isLoading ? (
          <div className="qf-thread-divider">불러오는 중…</div>
        ) : null}

        {history.hasNextPage ? (
          <button
            type="button"
            data-testid="thread-load-more"
            onClick={() => history.fetchNextPage()}
            className="mx-[var(--s-5)] mb-[var(--s-2)] block text-left text-[length:var(--fs-11)] text-text-muted underline"
          >
            {history.isFetchingNextPage ? '불러오는 중…' : '이전 답글 보기'}
          </button>
        ) : null}

        {replies.length > 0 ? (
          <div className="qf-thread-divider">{replies.length}개의 답글</div>
        ) : !history.isLoading ? (
          // task-047 iter7 (O7): thread empty state — root 만 있고 답글 0
          <div data-testid="thread-empty" className="qf-empty" style={{ padding: 'var(--s-3)' }}>
            <div className="qf-empty__title">첫 답글을 시작해보세요</div>
            <div className="qf-empty__body">
              아래에서 답글을 작성하면 작성자와 후속 댓글 작성자에게 알림이 갑니다.
            </div>
          </div>
        ) : null}

        {replies.map((m, idx) => {
          const prev = idx > 0 ? replies[idx - 1] : null;
          const isContinuation =
            !!prev &&
            !prev.deleted &&
            !m.deleted &&
            prev.authorId === m.authorId &&
            new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60_000;
          return (
            <ThreadReplyRow
              key={m.id}
              msg={m}
              authorName={nameById.get(m.authorId)}
              isContinuation={isContinuation}
              customEmojis={customEmojis.byName}
            />
          );
        })}
      </div>

      {/* S35 (FR-TH-18): jump-to-bottom 버튼. DS 에 `qf-thread-jump-btn` 정의가
          없어(데스크톱 패널용 jump 클래스 부재) app-layer DS 토큰으로 구성한다
          (raw hex/px 없음 — var(--..) + 등록 Tailwind 유틸만). DS-owner 가 정식
          `qf-thread-jump-btn` 을 추가하면 이 인라인을 교체한다 — follow-up. */}
      {/* A-04: jump 노출 시 스크린리더에 새 답글 도착을 polite 으로 알린다(시각
          jump 버튼과 별개로 비시각 사용자에게 컨텍스트 제공). sr-only 라
          시각 레이아웃 무영향. */}
      {showJump ? (
        <div role="status" aria-live="polite" className="sr-only">
          새 답글이 있습니다
        </div>
      ) : null}
      {showJump ? (
        <button
          type="button"
          data-testid="thread-jump-btn"
          onClick={jumpToBottom}
          aria-label="최신 답글로 이동"
          className={cn(
            'absolute left-1/2 -translate-x-1/2 z-[var(--z-sticky)]',
            'flex items-center gap-[var(--s-2)]',
            'rounded-[var(--r-pill)] px-[var(--s-4)] py-[var(--s-2)]',
            'text-[length:var(--fs-12)]',
            // A-05: 인라인 boxShadow:var(--elev-3) 가 기본 :focus-visible ring(box-
            // shadow)을 덮어 키보드 포커스가 안 보였다. focus-visible 에서 ring-focus
            // 그림자로 교체 + 기본 outline 제거(데스크톱 jump-to-unread 패턴 일치).
            'focus-visible:shadow-[var(--ring-focus)] focus-visible:outline-none',
          )}
          // app-layer 인라인 스타일도 전부 DS 토큰(var(--..))만 사용 — raw hex/px
          // 없음. border/배경/그림자/글자색을 토큰으로 직접 지정한다.
          style={{
            bottom: 'calc(var(--s-12) * 2)',
            border: '1px solid var(--border)',
            background: 'var(--bg-elevated)',
            color: 'var(--text)',
            boxShadow: 'var(--elev-3)',
          }}
        >
          <Icon name="chevron-down" size="sm" />
          <span>최신 답글</span>
        </button>
      ) : null}

      <ThreadComposer
        rootId={rootId}
        channelName={channelName}
        disabled={reply.isPending}
        // S38 (FR-TH-13): 잠긴 스레드에서 MEMBER 이하는 composer 가 잠긴다(읽기
        // 전용). OWNER/ADMIN 은 잠겨 있어도 답글 가능(서버 게이트 면제와 일치).
        locked={locked && !isModerator}
        onSubmit={(content, isBroadcast) =>
          reply.mutate({
            content,
            tempId: `tmp-${crypto.randomUUID()}`,
            idempotencyKey: crypto.randomUUID(),
            isBroadcast,
          })
        }
      />
    </aside>
  );
}

function ThreadReplyRow({
  msg,
  authorName,
  isContinuation,
  // 072-N0 (감사 D04): 커스텀 이모지 룩업 맵. 답글 본문도 루트와 동일하게
  // 메인 타임라인과 일관된 리치 렌더 경로를 타게 한다.
  customEmojis,
}: {
  msg: MessageDto;
  authorName?: string;
  isContinuation: boolean;
  customEmojis?: Map<string, CustomEmoji>;
}): JSX.Element {
  const isHead = !isContinuation;
  if (msg.deleted) {
    return (
      <div
        data-testid={`thread-reply-${msg.id}`}
        className="qf-thread-msg qf-thread-msg--cont italic text-text-muted"
      >
        <div className="qf-thread-msg__avatar" aria-hidden />
        <div>
          <div className="qf-thread-msg__body">(삭제된 답글)</div>
        </div>
      </div>
    );
  }
  return (
    <article
      data-testid={`thread-reply-${msg.id}`}
      className={cn('qf-thread-msg', isHead ? 'qf-thread-msg--head' : 'qf-thread-msg--cont')}
    >
      {isHead ? (
        <Avatar
          name={authorName ?? msg.authorId.slice(0, 2)}
          size="sm"
          className="qf-thread-msg__avatar"
        />
      ) : (
        <span className="qf-avatar qf-avatar--sm qf-thread-msg__avatar" aria-hidden="true" />
      )}
      <div className="min-w-0">
        {isHead ? (
          <div className="qf-thread-msg__meta">
            <span className="qf-thread-msg__author">{authorName ?? 'unknown'}</span>
            <span className="qf-thread-msg__time">
              {new Date(msg.createdAt).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          </div>
        ) : null}
        <div className="qf-thread-msg__body">
          {renderMessageContent(msg.content ?? '', customEmojis)}
        </div>
      </div>
    </article>
  );
}

function ThreadComposer({
  rootId,
  channelName,
  onSubmit,
  disabled,
  locked = false,
}: {
  rootId: string;
  channelName?: string;
  // S35 (FR-TH-06): 두 번째 인자로 'Also send to #channel' 체크 상태를 넘긴다.
  onSubmit: (content: string, isBroadcast: boolean) => void;
  disabled: boolean;
  // S38 (FR-TH-13): 잠긴 스레드 + 비-OWNER/ADMIN 이면 true → composer 비활성 +
  // placeholder '스레드가 잠겨 있습니다'. dispatcher 의 thread:lock:changed 수신으로
  // 루트 DTO 가 갱신되면 이 값이 실시간으로 바뀐다.
  locked?: boolean;
}): JSX.Element {
  // Persist the draft via compose-store keyed by thread:<rootId> so
  // closing + reopening the panel (or `?thread=` URL reload) keeps
  // what the user was mid-typing. Cleared on successful submit only.
  const key = threadDraftKey(rootId);
  const draft = useCompose((s) => s.drafts[key] ?? '');
  const setDraftStore = useCompose((s) => s.setDraft);
  const clearDraftStore = useCompose((s) => s.clearDraft);
  const setDraft = (v: string): void => setDraftStore(key, v);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // S35 (FR-TH-06): 'Also send to #channel' 체크 상태. 패널 로컬 상태 — 전송
  // 성공 후 false 로 리셋한다(매 답글마다 명시적 opt-in 이 안전한 기본값).
  const [broadcast, setBroadcast] = useState(false);

  // Same auto-grow rule as MessageComposer — single-line start, grows
  // up to 160px for the smaller panel, then scrolls internally.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = '0px';
    const next = Math.min(160, Math.max(22, el.scrollHeight));
    el.style.height = `${next}px`;
  }, [draft]);

  const submit = (): void => {
    // S38 (FR-TH-13): 잠긴 스레드는 제출을 막는다(서버도 403 으로 거부하나,
    // 클라에서 미리 차단해 헛된 낙관적 삽입/롤백을 피한다).
    if (locked) return;
    const trimmed = draft.trim();
    if (!trimmed) return;
    onSubmit(trimmed, broadcast);
    clearDraftStore(key);
    setBroadcast(false);
  };

  return (
    <form
      data-testid="thread-composer"
      className="qf-thread-composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div
        className={cn(
          'flex items-center gap-[var(--s-3)]',
          'rounded-[var(--r-lg)] border border-border-subtle bg-bg-input',
          'px-[var(--s-4)] py-[var(--s-3)]',
        )}
      >
        <textarea
          ref={textareaRef}
          data-testid="thread-input"
          aria-label="스레드 답장"
          value={draft}
          rows={1}
          // S38 fix-forward (a11y B-05): 잠긴 스레드는 종전 `disabled` 가 textarea 를
          // a11y 트리에서 제외해 스크린리더가 잠금 사유를 인지하지 못했다. 대신
          // aria-disabled + readOnly 로 포커스는 허용하되 입력을 막고(submit 도 차단),
          // aria-describedby 로 인접 sr-only 안내("스레드가 잠겨 있습니다")를 연결해
          // SR 사용자가 왜 입력이 안 되는지 듣게 한다.
          aria-disabled={locked || undefined}
          readOnly={locked}
          aria-describedby={locked ? `${rootId}-thread-locked-hint` : undefined}
          onChange={(e) => {
            if (locked) return; // readOnly 보조 — 잠금 시 입력 무시.
            setDraft(e.target.value);
          }}
          onKeyDown={(e) => {
            // task-021-R1-ime-enter-half-sends: guard against Enter
            // during Korean IME composition (composer + thread share
            // the same rule).
            const native = e.nativeEvent as KeyboardEvent & { isComposing?: boolean };
            if (native.isComposing || e.keyCode === 229) return;
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          maxLength={4000}
          placeholder={locked ? '스레드가 잠겨 있습니다' : '스레드에 답글…'}
          className="flex-1 resize-none bg-transparent outline-none placeholder:text-text-muted text-foreground disabled:cursor-not-allowed aria-disabled:cursor-not-allowed"
          // task-041 D: textarea sizing — minHeight matches the qf-input
          // 1-line baseline (22 ≈ --s-7), maxHeight = 8 × line-height
          // before internal scroll kicks in.
          style={{ minHeight: 'var(--s-7)', maxHeight: 'calc(var(--s-12) * 2)' }}
        />
      </div>
      {/* S38 fix-forward (a11y B-05): 잠금 사유 sr-only 안내. textarea 의
          aria-describedby 가 이 id 를 참조한다(잠겼을 때만 렌더). */}
      {locked ? (
        <span id={`${rootId}-thread-locked-hint`} className="sr-only">
          스레드가 잠겨 있습니다. 답글을 작성할 수 없습니다.
        </span>
      ) : null}
      <div className="qf-thread-composer__options">
        {/* S35 (FR-TH-06): 'Also send to #channel' — 체크 후 전송 시 채널
            타임라인에 broadcast 메시지(레이블 + 루트 excerpt)가 동시 게시된다.
            DS 클래스 qf-thread-composer__options/__checkbox 는 components.css 에
            이미 정의돼 있어 그대로 재사용한다(DS 무수정). */}
        <label className="qf-thread-composer__checkbox">
          <input
            type="checkbox"
            data-testid="thread-broadcast-checkbox"
            checked={broadcast}
            onChange={(e) => setBroadcast(e.target.checked)}
          />
          <span>{channelName ? `#${channelName} 에도 공유` : '채널에도 공유'}</span>
        </label>
      </div>
      {/* A-13: `hidden` 이 이미 a11y 트리에서 제외하므로 중복 aria-hidden 을
          제거한다(submit 트리거는 Enter 키 핸들러가 호출 — 시각/포커스 불필요). */}
      <button
        type="submit"
        hidden
        data-testid="thread-send"
        disabled={locked || disabled || draft.trim().length === 0}
      />
    </form>
  );
}
