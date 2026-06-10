import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type TouchEvent,
} from 'react';
import { isSystemMessageType, type MessageDto, type WorkspaceRole } from '@qufox/shared-types';
import { useAuth } from '../../features/auth/AuthProvider';
import { useMembers } from '../../features/workspaces/useWorkspaces';
import {
  useDeleteMessage,
  useMessageHistory,
  usePinMessage,
  useScrollFetch,
  useUnpinMessage,
  useUpdateMessage,
  useSendMessage,
} from '../../features/messages/useMessages';
// 071-M1 D9: 시트 액션 확장 — 저장/리마인더/신고/미읽음/핀은 데스크톱 모듈 재사용.
import {
  useInitSavedStatus,
  useToggleSave,
  savedKeys,
} from '../../features/saved/useSavedMessages';
import { ReminderModal } from '../../features/saved/ReminderModal';
import { useSetReminder } from '../../features/saved/useReminder';
import { saveMessage } from '../../features/saved/api';
import { deriveHasReminder } from '../../features/messages/rovingFocus';
import type { SaveStatus, SavedMessageListResponse } from '@qufox/shared-types';
import { ReportModal } from '../../features/messages/ReportModal';
import { MobileEmojiDrawer } from './MobileEmojiDrawer';
// 071-M3 F6: 편집 이력 시트.
import { MobileEditHistorySheet } from './MobileEditHistorySheet';
import { useToggleReaction } from '../../features/reactions/useReactions';
import { useQueryClient } from '@tanstack/react-query';
import { qk } from '../../lib/query-keys';
import {
  useMarkChannelRead,
  useMarkUnread,
  useUnreadSummary,
  zeroOutChannelUnread,
  type UnreadChannelSummary,
} from '../../features/channels/useUnread';
// 071-M1 D6: 첫 미읽 위치(count 역산)·점프 pill 판정 — 데스크톱 순수 함수 공유.
import { computeFirstUnreadIndex } from '../../features/messages/newMessages';
import { useSearchParams } from 'react-router-dom';
import { useNotifications } from '../../stores/notification-store';
import { useCompose } from '../../stores/compose-store';
import { renderMessageContent, extractMessageUrls } from '../../features/messages/parseContent';
// 071-M1 D3(FR-AM-07/09·RC07/08·RC12): 첨부 그리드+라이트박스·unfurl 카드·봇 rich embed —
// 데스크톱 컴포넌트 재사용(AttachmentsList 는 라이트박스 내장 단일 진실원).
import { AttachmentsList } from '../../features/attachments/AttachmentsList';
import { LinkPreview } from '../../features/messages/LinkPreview';
import { RichEmbeds } from '../../features/messages/RichEmbed';
import { useLinkPreviewsEnabled } from '../../stores/appearance-store';
// 071-M1 D4(FR-AM-01): + 버튼 업로드 — 데스크톱 트레이 파이프라인(presign→PUT→complete)
// 그대로 재사용. presign 이 워크스페이스 스코프라 DM(workspaceId=null)은 비활성.
import { useAttachmentUpload } from '../../features/attachments/useAttachmentUpload';
import { AttachmentTray } from '../../features/attachments/AttachmentTray';
import { clampAttachments, MAX_ATTACHMENTS } from '../../features/messages/clampAttachments';
// 071-M1 D8(FR-RC02): 4,000자 카운터/차단 — shared MESSAGE_MAX_LENGTH 단일 출처.
import { computeCounter } from '../../features/messages/composerCounter';
// 071-M3 F6 (FR-CH-23): 슬로우모드 쿨다운(공유 훅 — 전 플랫폼 최초 구현).
import { useSlowmodeCooldown } from '../../features/messages/useSlowmodeCooldown';
// 071-M1 D8(e)(FR-RC03/04/05/06): 자동완성 — 데스크톱 오케스트레이션 훅·listbox UI·
// 삽입 규칙(insertToken/tokenForRow)·stale-debounce 가드(detectTrigger 동기 재실행)를
// 전부 재사용한다. 슬래시 커맨드는 소스에서 제외(아래 acSources 주석 참고).
import { Autocomplete } from '../../features/messages/autocomplete/Autocomplete';
import {
  useAutocomplete,
  type AutocompleteRow,
  type AutocompleteSources,
  type RoleCandidate,
} from '../../features/messages/autocomplete/useAutocomplete';
import { insertToken } from '../../features/messages/autocomplete/insertToken';
import { detectTrigger } from '../../features/messages/autocomplete/detectTrigger';
import { useAutocompleteMaxHeight } from '../../features/messages/autocomplete/popupMaxHeight';
import { tokenForRow } from '../../features/messages/MessageComposer';
import type { RankableMember } from '../../features/messages/autocomplete/rankMembers';
import type { RankableChannel } from '../../features/messages/autocomplete/filterChannels';
import type { EmojiCandidate } from '../../features/messages/autocomplete/filterEmojis';
// 071-M1 D8(b)(FR-MSG-14/15): 대규모 특수멘션 confirm — 데스크톱과 동일 게이트 공유.
import {
  canUseSpecialMention,
  firstUnauthorizedSpecialMention,
  needsSpecialMentionConfirm,
  type SpecialMentionKey,
} from '../../features/messages/autocomplete/specialMention';
import { SpecialMentionConfirmDialog } from '../../features/messages/autocomplete/SpecialMentionConfirmDialog';
// 071-M2 E6 (FR-SC 모바일): 슬래시 커맨드 — 목록/실행/표면 전부 데스크톱 모듈 재사용.
import { useSlashCommands } from '../../features/messages/slashCommands/useSlashCommands';
import { executeSlashCommand } from '../../features/messages/slashCommands/api';
import { useEphemeralMessages } from '../../features/messages/slashCommands/useEphemeralMessages';
import { useGiphyPreviewStore } from '../../features/messages/slashCommands/useGiphyPreview';
import { EphemeralList } from '../../features/messages/slashCommands/EphemeralList';
import { GiphyPreviewSlot } from '../../features/messages/slashCommands/GiphyPreviewSlot';
import {
  detectClientSlashAction,
  detectSlashExecution,
  type ClientSlashAction,
} from '../../features/messages/composerSlash';
import { useMediaCollapseStore } from '../../features/messages/mediaCollapseStore';
import { useTheme } from '../../design-system/theme/ThemeProvider';
import { useNavigate } from 'react-router-dom';
// 071-M1 D8(c)(FR-CH-19): ANNOUNCEMENT 게시 제한 판정용 채널 타입 조회.
import { useChannelList } from '../../features/channels/useChannels';
import { useRoles, useWorkspace } from '../../features/workspaces/useWorkspaces';
import { usePresence } from '../../features/realtime/usePresence';
// 071-M1 D1: 데스크톱과 동일한 렌더 코어를 공유한다 — 그루핑 규칙·날짜 구분선·
// ReDoS-안전 AST 렌더러(멘션 pill/스포일러/헤딩)·점보 이모지·시스템 행·스레드 chip.
import { isContinuation } from '../../features/messages/grouping';
import { isSameLocalDay } from '../../features/messages/formatMessageTime';
import { DayDivider } from '../../features/messages/DayDivider';
import { SystemMessage } from '../../features/messages/SystemMessage';
import { renderAst, type MentionLookup } from '../../features/messages/renderAst';
import { isJumboEmoji } from '../../features/messages/jumboEmoji';
import { threadChipVisible } from '../../features/messages/threadActionGate';
import { useCustomEmojis } from '../../features/emojis/useCustomEmojis';
import type { CustomEmoji } from '../../features/emojis/api';
// 071-M1 D2: 리액션 칩 행 — 데스크톱 ReactionBar 재사용(칩 토글 + 피커).
import { ReactionBar } from '../../features/reactions/ReactionBar';
// 071-M1 D7(FR-P07/RT-08·09): 타이핑 — 표시는 공유 TypingIndicator, 발행은 TypingEmitter
// (스로틀/idle-stop 내장). emit 시점마다 소켓 재조회(재연결 안전 — 데스크톱과 동일).
import { TypingIndicator } from '../../features/typing/TypingIndicator';
import { TypingEmitter } from '../../features/typing/typingEmitter';
import { getSocket } from '../../lib/socket';
import { WS_EVENTS } from '@qufox/shared-types';
import { Avatar, Icon } from '../../design-system/primitives';
import { MobileMessageSheet } from './MobileMessageSheet';
import { PANEL_EDGE_PX } from './MobilePanels';
import { MobileEditSheet } from './MobileEditSheet';
import { ThreadPanel } from '../../features/threads/ThreadPanel';
import { cn } from '../../lib/cn';

/**
 * Mobile chat screen — scrolling qf-m-msg list + qf-m-composer
 * pinned to the bottom above qf-m-tabbar. Long-press on a message
 * opens a bottom sheet (reply / copy / delete). Swipe-right on a
 * message sends the bottom sheet's "reply in thread" action
 * immediately (matches Discord's swipe-to-reply).
 */
export function MobileMessages({
  workspaceId,
  workspaceSlug,
  channelId,
  channelName,
  extraNames,
}: {
  /** null for Global DM channels — routes through /me/dms/:ch/messages. */
  workspaceId: string | null;
  workspaceSlug: string | null;
  channelId: string;
  channelName: string;
  /**
   * DM callers pass {userId→username} so authors who don't share a
   * workspace with the viewer still render with their real name.
   */
  extraNames?: Map<string, string>;
}): JSX.Element {
  const { user } = useAuth();
  const { data: members } = useMembers(workspaceId ?? undefined);
  const history = useMessageHistory(workspaceId, channelId);
  const delMut = useDeleteMessage(workspaceId, channelId);
  const updMut = useUpdateMessage(workspaceId, channelId);
  const reactMut = useToggleReaction(workspaceId, channelId);
  // 071-M1 D8(b)(FR-MSG-14): 서버 BULK_MENTION_CONFIRM_REQUIRED(409) 안전망 —
  // 클라 선제 confirm 을 우회했거나 멤버 수 추정이 어긋나면 서버가 409 를 던지고,
  // 이 콜백이 보류 페이로드를 받아 confirm dialog 를 띄운다(데스크톱 S94 동일).
  const [serverBulkConfirm, setServerBulkConfirm] = useState<{
    content: string;
    attachmentIds?: string[];
    mention?: string;
    clientNonce: string;
  } | null>(null);
  // 071-M1 D5(FR-MSG-04/05): retry 는 동일 clientNonce 로 실패 낙관 행을 재전송한다.
  const { send, retry } = useSendMessage(workspaceId, channelId, (info) =>
    setServerBulkConfirm(info),
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const [sheetMsg, setSheetMsg] = useState<MessageDto | null>(null);
  // S103 (FR-MSG-06 모바일): 편집 중인 메시지(시트에서 '메시지 편집' 선택 시 세팅).
  // 비-null 이면 MobileEditSheet 오버레이를 띄운다.
  const [editingMsg, setEditingMsg] = useState<MessageDto | null>(null);
  // S35 (FR-TH-05): 모바일 전체화면 스레드 패널 상태. 시트의 '스레드에서 답글'
  // 액션이 루트 messageId 를 세팅한다. 워크스페이스 채널에서만 연다(DM 스레드는
  // 데스크톱과 동일하게 비범위 — workspaceId 가 null 인 DM 은 열지 않는다).
  const [threadRootId, setThreadRootId] = useState<string | null>(null);
  // S35 fix-forward (a11y BLOCKER): 모바일 스레드 dialog 를 닫을 때 포커스를
  // 패널을 연 트리거로 되돌리기 위해, 패널 오픈 직전의 활성 요소를 보관한다.
  // dialog 닫힘 시 이 요소로 focus 를 복귀시켜 키보드/스크린리더 컨텍스트가
  // 배경으로 튀지 않게 한다(WAI-ARIA dialog 패턴).
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // suppress unused warnings (workspaceSlug 은 시그니처 호환용 미사용 prop).
  void workspaceSlug;

  const messages = useMemo<MessageDto[]>(() => {
    const pages = history.data?.pages ?? [];
    return [...pages.flatMap((p) => p.items)].reverse();
  }, [history.data]);

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const x of members?.members ?? []) m.set(x.userId, x.user.username);
    if (extraNames) for (const [k, v] of extraNames) if (!m.has(k)) m.set(k, v);
    return m;
  }, [members, extraNames]);

  // 071-M1 D1: AST 멘션 pill 의 표시명 resolver(데스크톱 mentionLookup 과 동일 소스).
  const mentionLookup = useMemo<MentionLookup>(
    () => ({ userName: (userId: string) => nameById.get(userId) }),
    [nameById],
  );
  // 커스텀 이모지 byName(+별칭) — CustomEmojiProvider 가 모바일 트리에 없으므로
  // 프로바이더와 동일 로직으로 직접 구성(DM=workspace 없음 → 빈 맵, 리터럴 유지).
  const { data: customEmojiData } = useCustomEmojis(workspaceId ?? null);
  const customEmojiByName = useMemo(() => {
    const byName = new Map<string, CustomEmoji>();
    for (const ce of customEmojiData?.items ?? []) {
      byName.set(ce.name, ce);
      for (const alias of ce.aliases ?? []) if (!byName.has(alias)) byName.set(alias, ce);
    }
    return byName;
  }, [customEmojiData?.items]);

  const roleById = useMemo(() => {
    const m = new Map<string, WorkspaceRole>();
    for (const x of members?.members ?? []) m.set(x.userId, x.role);
    return m;
  }, [members]);

  // ── 071-M1 D9: 시트 액션 확장 상태/뮤테이션 ─────────────────────────────
  const pinMut = usePinMessage(workspaceId, channelId);
  const unpinMut = useUnpinMessage(workspaceId, channelId);
  const saveMut = useToggleSave();
  const markUnreadMut = useMarkUnread(workspaceId ?? undefined);
  const setReminderMut = useSetReminder();
  const pushToast = useNotifications((s) => s.push);
  const [reminderTarget, setReminderTarget] = useState<{
    savedMessageId: string;
    channelName: string;
    hasReminder: boolean;
  } | null>(null);
  const [reportTargetId, setReportTargetId] = useState<string | null>(null);
  // 퀵반응 5종 밖 — 시트를 닫고 이모지 드로어를 연다(대상 메시지 스냅샷 유지).
  const [emojiDrawerMsg, setEmojiDrawerMsg] = useState<MessageDto | null>(null);
  // F6: 편집 이력 시트 대상.
  const [editHistoryMsg, setEditHistoryMsg] = useState<MessageDto | null>(null);

  // D9(FR-PS-05): 핀 권한 — 데스크톱 MessageItem 게이트와 동일(OWNER/ADMIN 또는
  // memberCanPin 채널의 MEMBER). 권한 비트 오버라이드는 서버가 최종 판정.
  const viewerRole = user ? (roleById.get(user.id) ?? null) : null;
  const { data: channelListForMeta } = useChannelList(workspaceId ?? undefined);
  const memberCanPin = useMemo(() => {
    if (!channelListForMeta) return true;
    const all = [
      ...channelListForMeta.uncategorized,
      ...channelListForMeta.categories.flatMap((c) => c.channels),
    ];
    return all.find((c) => c.id === channelId)?.memberCanPin ?? true;
  }, [channelListForMeta, channelId]);
  const canPinViewer =
    viewerRole === 'OWNER' || viewerRole === 'ADMIN' || (viewerRole === 'MEMBER' && memberCanPin);

  // D9(FR-PS-13): 렌더 중 메시지의 저장 상태 1회 seed(증분 — 데스크톱 S52 동일).
  const savedSeedIds = useMemo(
    () => messages.map((m) => m.id).filter((id) => !id.startsWith('tmp-')),
    [messages],
  );
  useInitSavedStatus(savedSeedIds);

  useScrollFetch(scrollRef, () => {
    if (history.hasNextPage && !history.isFetchingNextPage) void history.fetchNextPage();
  });

  // 071-M1 D6(FR-RS-06): 첫 미읽 구분선 입력 스냅샷. 아래 zero-out 효과가 캐시를
  // 0 으로 누르기 *전에* 채널 진입 시점의 unreadCount 를 고정한다(효과 선언 순서로
  // 보장 — 이 효과가 먼저 실행됨). summary 에 lastReadMessageId 가 없으므로
  // computeFirstUnreadIndex 의 count 역산 폴백을 쓴다.
  const { data: unreadSummary } = useUnreadSummary(workspaceId ?? undefined);
  // M1 리뷰 M-2: 종전 ref 스냅은 memo deps 에 없어, summary 가 messages 보다 늦게
  // 도착하는 하드 로드/딥링크 경로에서 구분선이 영영 미표시였다. useState 스냅
  // (render-phase 조건 세팅 — React 공식 'derived state' 조정 패턴)으로 바꿔
  // 늦은 스냅 세팅이 곧바로 재렌더·재계산되게 한다. 채널당 1회 고정은 동일.
  const [unreadSnap, setUnreadSnap] = useState<{
    channelId: string;
    unreadCount: number;
  } | null>(null);
  if (unreadSnap && unreadSnap.channelId !== channelId) {
    setUnreadSnap(null); // 채널 전환 — 새 채널에서 재스냅.
  }
  if (unreadSnap === null && unreadSummary) {
    const row = unreadSummary.channels.find((c) => c.channelId === channelId);
    setUnreadSnap({ channelId, unreadCount: row?.unreadCount ?? 0 });
  }
  const firstUnreadIndex = useMemo(() => {
    if (!unreadSnap || unreadSnap.channelId !== channelId) return null;
    return computeFirstUnreadIndex({
      messageIds: messages.map((m) => m.id),
      lastReadMessageId: null,
      unreadCount: unreadSnap.unreadCount,
    });
  }, [messages, channelId, unreadSnap]);

  // A-4(071-M0 C10): 모바일은 읽음 ACK 를 전혀 보내지 않아 모바일로 읽어도 미읽음/멘션
  // 배지가 영구 잔존했다 — 데스크톱 MessageColumn 의 채널-open 패턴(낙관적 zero-out +
  // POST read-ack)을 동일 적용한다. DM(workspaceId=null)은 데스크톱과 같은 이유로 스킵,
  // 커서 기반 정밀 ACK(FR-RS-02 AckScheduler)는 M1 범위.
  const qc = useQueryClient();
  const markRead = useMarkChannelRead(workspaceId ?? undefined);
  useEffect(() => {
    if (workspaceId === null) return;
    qc.setQueryData<{ channels: UnreadChannelSummary[] }>(
      qk.channels.unreadSummary(workspaceId),
      (old) => zeroOutChannelUnread(old, channelId),
    );
    markRead.mutate(channelId);
    // markRead 는 useMutation 의 안정 참조 — 채널 변경 시에만 재발화한다.
  }, [channelId, workspaceId, qc]);

  // D9: 저장 + 리마인더 — 데스크톱 MessageList handleSetReminder 와 동일 흐름
  // (저장 API → saved 캐시 낙관 반영 → ReminderModal). hasReminder 는 캐시된
  // saved 목록에서 역산(deriveHasReminder)한다.
  const deriveSavedHasReminder = (savedMessageId: string): boolean => {
    const statuses: SaveStatus[] = ['IN_PROGRESS', 'ARCHIVED', 'COMPLETED'];
    for (const status of statuses) {
      const list = qc.getQueryData<SavedMessageListResponse>(savedKeys.list(status));
      const found = list?.items.find((it) => it.id === savedMessageId);
      if (found) return deriveHasReminder(found);
    }
    return false;
  };
  const handleSetReminder = async (messageId: string): Promise<void> => {
    try {
      const res = await saveMessage(messageId);
      if (!res.savedMessageId) return;
      qc.setQueryData<boolean>(savedKeys.status(messageId), true);
      void qc.invalidateQueries({ queryKey: ['saved', 'list'] });
      void qc.invalidateQueries({ queryKey: savedKeys.count() });
      setReminderTarget({
        savedMessageId: res.savedMessageId,
        channelName,
        hasReminder: deriveSavedHasReminder(res.savedMessageId),
      });
    } catch {
      pushToast({
        variant: 'warning',
        title: '리마인더를 설정하지 못했습니다',
        body: '잠시 후 다시 시도하세요.',
        ttlMs: 4000,
      });
    }
  };

  // Auto-scroll to bottom on mount + new incoming. task-025 follow-4:
  // history prepend grows messages.length while isFetchingNextPage is
  // true and wasAtBottomRef stays true, so without a gate the old code
  // snapped the view to the bottom mid-fetch and threw the user off
  // the history they had just requested.
  const wasAtBottomRef = useRef(true);
  const hasAnchoredRef = useRef(false);
  const prevScrollHeightRef = useRef(0);
  // 071-M1 D6(FR-RS-07 모바일 단순화): 하단 이탈 중 도착한 새 메시지 수 — jump 버튼 배지.
  const prevLastIdRef = useRef<string | null>(null);
  const prevLenRef = useRef(0);
  const [newWhileAway, setNewWhileAway] = useState(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || messages.length === 0) return;
    const lastId = messages[messages.length - 1]?.id ?? null;
    if (!hasAnchoredRef.current) {
      el.scrollTop = el.scrollHeight;
      hasAnchoredRef.current = true;
      prevScrollHeightRef.current = el.scrollHeight;
      prevLastIdRef.current = lastId;
      prevLenRef.current = messages.length;
      return;
    }
    if (history.isFetchingNextPage) {
      // Mid-prepend: preserve the user's anchor by shifting scrollTop
      // by however much the list grew upward.
      const delta = el.scrollHeight - prevScrollHeightRef.current;
      if (delta > 0) el.scrollTop = el.scrollTop + delta;
      prevScrollHeightRef.current = el.scrollHeight;
      prevLastIdRef.current = lastId;
      prevLenRef.current = messages.length;
      return;
    }
    // append(마지막 id 변경) 인데 하단 이탈 상태 → jump 배지 카운트 누적.
    // M1 리뷰 L-7: 내가 보낸 메시지(낙관 tmp- 포함)는 배지 대상이 아니라 하단
    // 스냅 대상이다 — 자기 전송에 "새 메시지 1" 배지가 뜨던 노이즈 제거.
    const lastMsg = messages[messages.length - 1];
    const mineAppend =
      lastMsg !== undefined && (lastMsg.authorId === user?.id || lastMsg.id.startsWith('tmp-'));
    if (lastId !== prevLastIdRef.current && !wasAtBottomRef.current && !mineAppend) {
      const appended = Math.max(1, messages.length - prevLenRef.current);
      setNewWhileAway((n) => n + appended);
    }
    if (wasAtBottomRef.current || mineAppend) el.scrollTop = el.scrollHeight;
    prevScrollHeightRef.current = el.scrollHeight;
    prevLastIdRef.current = lastId;
    prevLenRef.current = messages.length;
  }, [messages.length, history.isFetchingNextPage, messages]);

  // 071-M1 D6: `?msg=` 점프 — 리스트에 있으면 스크롤+2초 강조 후 파라미터 제거,
  // 히스토리를 다 불러왔는데도 없으면 토스트 1회(around 로드는 M1 범위 외 — 071 문서).
  const [sp, setSp] = useSearchParams();
  const rawJump = sp.get('msg');
  const jumpId =
    rawJump && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawJump)
      ? rawJump
      : null;
  // 071-M2 E3 (FR-TH-09 모바일): `?thread=<rootId>` 소비 — 스레드 인박스 항목
  // 진입 시 전체화면 스레드 패널을 연다(데스크톱 ?thread= 소비와 동등).
  // 1회 소비 후 URL 에서 파라미터를 정리한다. DM(workspaceId=null)은 비범위.
  const rawThread = sp.get('thread');
  const threadParam =
    rawThread && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawThread)
      ? rawThread
      : null;
  const threadHandledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!threadParam || threadHandledRef.current === threadParam) return;
    if (workspaceId === null) return;
    threadHandledRef.current = threadParam;
    setThreadRootId(threadParam);
    setSp(
      (prevParams) => {
        const next = new URLSearchParams(prevParams);
        next.delete('thread');
        return next;
      },
      { replace: true },
    );
  }, [threadParam, workspaceId, setSp]);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const jumpHandledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!jumpId || jumpHandledRef.current === jumpId) return;
    const clearParam = (): void =>
      setSp(
        (prevParams) => {
          const next = new URLSearchParams(prevParams);
          next.delete('msg');
          next.delete('thread');
          return next;
        },
        { replace: true },
      );
    if (messages.some((m) => m.id === jumpId)) {
      jumpHandledRef.current = jumpId;
      const el = document.querySelector(`[data-testid="mobile-msg-${jumpId}"]`);
      el?.scrollIntoView({ block: 'center' });
      wasAtBottomRef.current = false;
      setHighlightId(jumpId);
      window.setTimeout(() => setHighlightId(null), 2000);
      clearParam();
      return;
    }
    if (!history.hasNextPage && !history.isFetchingNextPage && messages.length > 0) {
      jumpHandledRef.current = jumpId;
      pushToast({ variant: 'warning', title: '메시지를 찾을 수 없습니다', ttlMs: 4000 });
      clearParam();
    }
  }, [jumpId, messages, history.hasNextPage, history.isFetchingNextPage, setSp, pushToast]);

  return (
    <>
      <div
        ref={scrollRef}
        data-testid="mobile-message-list"
        className="flex-1 overflow-y-auto px-[var(--s-3)] py-[var(--s-3)] min-h-0"
        onScroll={(e) => {
          const el = e.currentTarget;
          const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          wasAtBottomRef.current = near;
          // D6: 하단 복귀 시 jump 배지 해제.
          if (near) setNewWhileAway(0);
        }}
      >
        {/* 071-M1 D1: 날짜 구분선 + 그루핑(--head/--cont) + 시스템 행 + 스레드 chip —
            데스크톱과 동일 순수 모듈(isContinuation/isSameLocalDay/SystemMessage)을 공유. */}
        {messages.map((m, i) => {
          const prev = i > 0 ? messages[i - 1] : null;
          const dayDivider =
            !prev || !isSameLocalDay(m.createdAt, prev.createdAt) ? (
              <DayDivider iso={m.createdAt} />
            ) : null;
          {
            /* D6(FR-RS-06): 첫 미읽 메시지 위에 NEW MESSAGES 경계(DS qf-m-unread-divider). */
          }
          const unreadDivider =
            firstUnreadIndex === i ? (
              <div className="qf-m-unread-divider" data-testid="mobile-unread-divider">
                <span className="qf-m-unread-divider__label">새 메시지</span>
                <span className="qf-m-unread-divider__pill">{unreadSnap?.unreadCount ?? ''}</span>
              </div>
            ) : null;
          if (isSystemMessageType(m.type)) {
            return (
              <div key={m.id}>
                {dayDivider}
                {unreadDivider}
                <SystemMessage
                  msg={m}
                  onOpenThread={workspaceId ? (rootId) => setThreadRootId(rootId) : undefined}
                />
              </div>
            );
          }
          const chipVisible =
            workspaceId !== null &&
            threadChipVisible(m, m.thread, true) &&
            !m.id.startsWith('tmp-');
          return (
            <div key={m.id}>
              {dayDivider}
              {unreadDivider}
              <MobileMessageRow
                msg={m}
                cont={isContinuation(m, prev)}
                isMine={m.authorId === user?.id}
                highlighted={highlightId === m.id}
                mentionsMe={astMentionsViewer(m.contentAst, user?.id)}
                authorName={nameById.get(m.authorId)}
                customEmojiByName={customEmojiByName}
                mentions={mentionLookup}
                onLongPress={() => setSheetMsg(m)}
                // 071-M2 E6 (M1 리뷰 M-4): 종전 replyTarget 배너는 전송에 실리지
                // 않는 데드엔드였다 — 스와이프 답장은 스레드 답글로 통일(디스코드
                // 모바일 동일). DM(workspaceId=null)은 스레드 비범위라 no-op.
                onSwipeReply={() => {
                  if (!workspaceId || m.id.startsWith('tmp-')) return;
                  previousFocusRef.current = document.activeElement as HTMLElement | null;
                  setThreadRootId(m.parentMessageId ?? m.id);
                }}
                onToggleReaction={
                  m.id.startsWith('tmp-')
                    ? undefined
                    : (emoji, byMe) =>
                        reactMut.toggle({ messageId: m.id, emoji, currentlyByMe: byMe })
                }
                customEmojiList={customEmojiData?.items ?? []}
                onRetry={() => retry(m.id, m.content ?? '')}
              />
              {chipVisible && m.thread ? (
                <button
                  type="button"
                  data-testid={`mobile-thread-chip-${m.id}`}
                  className="qf-thread-chip ml-[calc(var(--m-gutter)+40px+12px)]"
                  aria-label={`${m.thread.replyCount}개 답글 보기`}
                  onClick={() => {
                    previousFocusRef.current = document.activeElement as HTMLElement | null;
                    setThreadRootId(m.id);
                  }}
                >
                  <span className="qf-thread-chip__count">{m.thread.replyCount}개 답글</span>
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      {/* D6(FR-RS-07 모바일): 하단 이탈 중 새 메시지 도착 — DS qf-m-jump-btn(+배지). */}
      {newWhileAway > 0 ? (
        <button
          type="button"
          data-testid="mobile-jump-btn"
          className="qf-m-jump-btn"
          aria-label={`새 메시지 ${newWhileAway}개 — 최신으로 이동`}
          onClick={() => {
            const el = scrollRef.current;
            if (el) el.scrollTop = el.scrollHeight;
            wasAtBottomRef.current = true;
            setNewWhileAway(0);
          }}
        >
          <Icon name="chevron-down" size="sm" />
          <span className="qf-m-jump-btn__badge">{newWhileAway > 99 ? '99+' : newWhileAway}</span>
        </button>
      ) : null}
      {/* D7: 타이핑 인디케이터 — 리스트와 컴포저 사이(데스크톱과 동일 위치). */}
      <TypingIndicator channelId={channelId} viewerId={user?.id ?? null} nameByUserId={nameById} />
      {/* 071-M2 E6 (FR-SC-05/07): 슬래시 표면 — EPHEMERAL 인라인 응답 + /giphy
          발신자 전용 프리뷰(데스크톱 MessageColumn 과 동일 장착 위치). */}
      <EphemeralList channelId={channelId} />
      {workspaceId ? <GiphyPreviewSlot workspaceId={workspaceId} channelId={channelId} /> : null}
      <MobileComposer
        workspaceId={workspaceId}
        channelId={channelId}
        channelName={channelName}
        send={send}
        inputRef={composerInputRef}
      />
      {/* D8(b)(FR-MSG-14): 서버 안전망 confirm — 확인 시 원래 clientNonce 로 재전송해
          같은 낙관 행을 되살린다(failed 버블 잔류 방지 — 데스크톱 S94 MED-1 동일). */}
      <SpecialMentionConfirmDialog
        open={serverBulkConfirm !== null}
        mentionKey={
          serverBulkConfirm
            ? ((serverBulkConfirm.mention as SpecialMentionKey | undefined) ?? 'channel')
            : null
        }
        onConfirm={() => {
          const pending = serverBulkConfirm;
          setServerBulkConfirm(null);
          if (!pending) return;
          send(pending.content, pending.attachmentIds, true, pending.clientNonce);
        }}
        onCancel={() => setServerBulkConfirm(null)}
      />
      {sheetMsg ? (
        <MobileMessageSheet
          msg={sheetMsg}
          isMine={sheetMsg.authorId === user?.id}
          onClose={() => setSheetMsg(null)}
          onDelete={() => {
            delMut.mutate(sheetMsg.id);
            setSheetMsg(null);
          }}
          onCopy={() => {
            // M1 리뷰 L-5: 평문 정본(contentPlain) 우선 — raw mrkdwn/@{uuid}
            // 토큰이 클립보드에 섞이지 않게 한다(데스크톱 copyPlainText 동일).
            void navigator.clipboard?.writeText(sheetMsg.contentPlain ?? sheetMsg.content ?? '');
            setSheetMsg(null);
          }}
          // 071-M2 E6 (M1 리뷰 M-4): '답장' = 스레드 답글(데드엔드 replyTarget
          // 배너 폐기). DM/tmp 행은 시트가 항목을 숨긴다(미전달).
          onReply={
            workspaceId && !sheetMsg.id.startsWith('tmp-')
              ? () => {
                  previousFocusRef.current =
                    (document.activeElement as HTMLElement | null) ??
                    document.querySelector<HTMLElement>(
                      `[data-testid="mobile-msg-${sheetMsg.id}"]`,
                    );
                  setThreadRootId(sheetMsg.parentMessageId ?? sheetMsg.id);
                  setSheetMsg(null);
                }
              : undefined
          }
          onReact={(emoji) => {
            if (!sheetMsg.id.startsWith('tmp-')) {
              // M1 리뷰 L-6: 토글 방향은 시트 오픈 시점 스냅샷이 아니라 캐시
              // 최신 행에서 읽는다(드로어 경로와 동일 — 시트가 열린 사이 타
              // 기기에서 토글돼도 역방향 동작 없음).
              const live = messages.find((mm) => mm.id === sheetMsg.id) ?? sheetMsg;
              reactMut.toggle({
                messageId: sheetMsg.id,
                emoji,
                currentlyByMe: live.reactions?.find((r) => r.emoji === emoji)?.byMe ?? false,
              });
            }
            setSheetMsg(null);
          }}
          // D9: 퀵 5종 밖 — 시트를 닫고 이모지 드로어로 전환(tmp/삭제 행 제외).
          onMoreReactions={
            !sheetMsg.id.startsWith('tmp-') && !sheetMsg.deleted
              ? () => {
                  setEmojiDrawerMsg(sheetMsg);
                  setSheetMsg(null);
                }
              : undefined
          }
          // D9(FR-PS-05): 핀/해제 — 게이트는 데스크톱과 동일(ws 채널·비-tmp·권한),
          // 토스트 카피도 데스크톱 runPin/runUnpin 과 동일.
          onPin={
            workspaceId &&
            !sheetMsg.id.startsWith('tmp-') &&
            !sheetMsg.deleted &&
            !sheetMsg.pinnedAt &&
            canPinViewer
              ? () => {
                  setSheetMsg(null);
                  pinMut
                    .mutateAsync(sheetMsg.id)
                    .then(() =>
                      pushToast({ variant: 'success', title: '메시지 고정', ttlMs: 2000 }),
                    )
                    .catch((e: unknown) => {
                      const code = (e as { errorCode?: string } | undefined)?.errorCode;
                      pushToast({
                        variant: 'danger',
                        title: '고정 실패',
                        body:
                          code === 'MESSAGE_PIN_CAP_EXCEEDED'
                            ? '채널당 최대 50개까지 고정할 수 있습니다'
                            : '잠시 후 다시 시도하세요.',
                        ttlMs: 4000,
                      });
                    });
                }
              : undefined
          }
          onUnpin={
            workspaceId && !sheetMsg.id.startsWith('tmp-') && !!sheetMsg.pinnedAt && canPinViewer
              ? () => {
                  setSheetMsg(null);
                  unpinMut
                    .mutateAsync(sheetMsg.id)
                    .then(() =>
                      pushToast({ variant: 'success', title: '메시지 고정 해제', ttlMs: 2000 }),
                    )
                    .catch(() =>
                      pushToast({
                        variant: 'danger',
                        title: '고정 해제 실패',
                        body: '잠시 후 다시 시도하세요.',
                        ttlMs: 4000,
                      }),
                    );
                }
              : undefined
          }
          // D9(FR-PS-07/13): 개인 저장 토글(낙관적) — tmp/삭제 행 제외.
          onToggleSave={
            !sheetMsg.id.startsWith('tmp-') && !sheetMsg.deleted
              ? (currentlySaved) => {
                  saveMut.mutate({ messageId: sheetMsg.id, currentlySaved });
                  setSheetMsg(null);
                }
              : undefined
          }
          isSaved={qc.getQueryData<boolean>(savedKeys.status(sheetMsg.id)) === true}
          // D9: 저장 후 리마인더 모달.
          onSetReminder={
            !sheetMsg.id.startsWith('tmp-') && !sheetMsg.deleted
              ? () => {
                  setSheetMsg(null);
                  void handleSetReminder(sheetMsg.id);
                }
              : undefined
          }
          // D9(FR-RS-08): 이 메시지 직전으로 읽음 커서 후진(ws 채널 한정).
          onMarkUnread={
            workspaceId && !sheetMsg.id.startsWith('tmp-')
              ? () => {
                  setSheetMsg(null);
                  markUnreadMut
                    .mutateAsync({ channelId, messageId: sheetMsg.id })
                    .then(() =>
                      pushToast({ variant: 'success', title: '미읽음으로 표시', ttlMs: 2000 }),
                    )
                    .catch(() =>
                      pushToast({
                        variant: 'warning',
                        title: '미읽음 표시 실패',
                        body: '잠시 후 다시 시도하세요.',
                        ttlMs: 4000,
                      }),
                    );
                }
              : undefined
          }
          // F6(FR-MSG-08): 편집 이력 — edited 행 + ws 채널 한정(서버 스코프).
          onEditHistory={
            workspaceId && !sheetMsg.id.startsWith('tmp-') && sheetMsg.editedAt
              ? () => {
                  setEditHistoryMsg(sheetMsg);
                  setSheetMsg(null);
                }
              : undefined
          }
          // D9(FR-RM11): 타인 메시지 신고(ws 채널·비-tmp·비삭제).
          onReport={
            workspaceId &&
            !sheetMsg.id.startsWith('tmp-') &&
            !sheetMsg.deleted &&
            sheetMsg.authorId !== user?.id
              ? () => {
                  setReportTargetId(sheetMsg.id);
                  setSheetMsg(null);
                }
              : undefined
          }
          // S103 (FR-MSG-06 모바일): 내 메시지만 편집. 낙관적(tmp-) 행은 서버 id·
          // version 이 없어 PATCH 불가, 삭제된 행은 본문이 없으므로 숨긴다(데스크톱
          // editRequestNonce 게이트와 동일 정책). 편집 시트로 전환한다.
          onEdit={
            sheetMsg.authorId === user?.id && !sheetMsg.id.startsWith('tmp-') && !sheetMsg.deleted
              ? () => {
                  setEditingMsg(sheetMsg);
                  setSheetMsg(null);
                }
              : undefined
          }
          // S35 (FR-TH-05): 워크스페이스 채널에서만 스레드 진입(DM 비범위).
          // 답글(parentMessageId 보유)을 탭하면 그 루트의 스레드를 연다.
          // 낙관적(tmp-) 행은 서버 id 가 없어 스레드를 열 수 없으므로 숨긴다.
          onOpenThread={
            workspaceId && !sheetMsg.id.startsWith('tmp-')
              ? () => {
                  // dialog 오픈 직전 포커스를 보관(닫힐 때 복귀 대상). 시트는
                  // 곧 닫히므로, 시트를 띄운 원본 메시지 행으로 폴백한다.
                  previousFocusRef.current =
                    (document.activeElement as HTMLElement | null) ??
                    document.querySelector<HTMLElement>(
                      `[data-testid="mobile-msg-${sheetMsg.id}"]`,
                    );
                  setThreadRootId(sheetMsg.parentMessageId ?? sheetMsg.id);
                  setSheetMsg(null);
                }
              : undefined
          }
        />
      ) : null}
      {/* S103 (FR-MSG-06 모바일): 메시지 편집 바텀시트. 저장 시 낙관적 잠금
          PATCH(updMut) — 성공하면 editingMsg 를 풀어 닫고, 충돌/검증 실패는 훅이
          토스트로 안내하며 시트를 유지한다(MobileEditSheet 내부에서 reject 흡수). */}
      {editingMsg ? (
        <MobileEditSheet
          msg={editingMsg}
          onCancel={() => setEditingMsg(null)}
          onSave={async (content) => {
            // S103 리뷰 HIGH-1: 편집 시트가 열린 사이 다른 클라가 같은 메시지를
            // 수정하면 낙관잠금 409 → 훅(applyEditConflict)이 캐시를 최신 version 으로
            // 갱신한다. expectedVersion 을 editingMsg(시트 오픈 스냅샷) 대신 *현재
            // 캐시*(messages memo)의 최신 version 으로 재도출해야, 충돌 후 재시도가
            // 새 version 으로 성공한다(stale version 무한 409 데드엔드 방지 — 데스크톱
            // MessageList onEditSave 가 매 렌더 m.version 을 재읽는 것과 동일 효과).
            // 캐시 밖(페이지네이션) 이면 스냅샷 version 으로 폴백.
            const live = messages.find((m) => m.id === editingMsg.id);
            await updMut.mutateAsync({
              msgId: editingMsg.id,
              content,
              expectedVersion: live?.version ?? editingMsg.version,
            });
            setEditingMsg(null);
          }}
        />
      ) : null}
      {/* S35 (FR-TH-05): 모바일 전체화면 스레드 패널. ThreadPanel 의 모든 로직을
          재사용하고 mobile 플래그로 app-layer 전체화면 레이아웃을 입힌다(DS 무수정).
          워크스페이스 채널에서만 연다(workspaceId 보장). */}
      {threadRootId && workspaceId ? (
        <ThreadPanel
          mobile
          workspaceId={workspaceId}
          channelId={channelId}
          channelName={channelName}
          rootId={threadRootId}
          onClose={() => {
            setThreadRootId(null);
            // dialog 닫힘 → 트리거(또는 원본 메시지 행)로 포커스 복귀.
            const prev = previousFocusRef.current;
            previousFocusRef.current = null;
            // 행이 여전히 포커스 가능하도록 다음 프레임에 복귀(언마운트 후).
            requestAnimationFrame(() => prev?.focus?.());
          }}
        />
      ) : null}
      {/* D9: 이모지 드로어 — 퀵 5종 밖 반응. 토글 방향은 드로어 선택 시점의 캐시
          최신 행에서 byMe 를 재조회한다(시트 스냅샷이 아닌 messages memo). */}
      {emojiDrawerMsg ? (
        <MobileEmojiDrawer
          onClose={() => setEmojiDrawerMsg(null)}
          customEmojis={customEmojiData?.items.map((ce) => ({
            id: ce.id,
            name: ce.name,
            url: ce.url,
          }))}
          onSelect={(emoji) => {
            if (emojiDrawerMsg.id.startsWith('tmp-')) return;
            const live = messages.find((m) => m.id === emojiDrawerMsg.id) ?? emojiDrawerMsg;
            reactMut.toggle({
              messageId: emojiDrawerMsg.id,
              emoji,
              currentlyByMe: live.reactions?.find((r) => r.emoji === emoji)?.byMe ?? false,
            });
          }}
        />
      ) : null}
      {/* F6: 편집 이력 시트. */}
      {editHistoryMsg && workspaceId ? (
        <MobileEditHistorySheet
          workspaceId={workspaceId}
          channelId={channelId}
          msg={editHistoryMsg}
          onClose={() => setEditHistoryMsg(null)}
        />
      ) : null}
      {/* D9(FR-RM11): 신고 모달 — 데스크톱 ReportModal 재사용. */}
      {workspaceId && reportTargetId ? (
        <ReportModal
          workspaceId={workspaceId}
          channelId={channelId}
          messageId={reportTargetId}
          onClose={() => setReportTargetId(null)}
        />
      ) : null}
      {/* D9: 리마인더 설정 모달 — SavedView/MessageList 와 동일 컴포넌트·뮤테이션. */}
      {reminderTarget ? (
        <ReminderModal
          open={reminderTarget !== null}
          channelName={reminderTarget.channelName}
          hasReminder={reminderTarget.hasReminder}
          onClose={() => setReminderTarget(null)}
          onSubmit={(reminderAt) =>
            setReminderMut.mutate({
              savedMessageId: reminderTarget.savedMessageId,
              reminderAt,
            })
          }
        />
      ) : null}
    </>
  );
}

/**
 * 071-M1 D1: 뷰어 멘션 판정 — contentAst 를 1회 순회해 mention_user(내 id)가
 * 있으면 true. AST 스키마에 의존하지 않는 관대한 워커(노드 모양 변화에 안전).
 */
function astMentionsViewer(ast: unknown, meId: string | undefined): boolean {
  if (!ast || !meId) return false;
  const stack: unknown[] = [ast];
  let guard = 0;
  while (stack.length > 0 && guard < 5_000) {
    guard += 1;
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
      continue;
    }
    if (typeof node !== 'object' || node === null) continue;
    const rec = node as Record<string, unknown>;
    if (rec.type === 'mention_user' && rec.userId === meId) return true;
    for (const v of Object.values(rec)) {
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return false;
}

function MobileMessageRow({
  msg,
  cont,
  isMine,
  highlighted,
  mentionsMe,
  authorName,
  customEmojiByName,
  mentions,
  onLongPress,
  onSwipeReply,
  onToggleReaction,
  customEmojiList,
  onRetry,
}: {
  msg: MessageDto;
  /** 그루핑 continuation — 아바타/메타 숨김(qf-m-msg--cont). */
  cont: boolean;
  isMine: boolean;
  /** `?msg=` 점프 직후 2초 강조. */
  highlighted: boolean;
  /** 본문에 내 멘션 포함 — 행 배경 강조(--mention-bg). */
  mentionsMe: boolean;
  authorName?: string;
  customEmojiByName: Map<string, CustomEmoji>;
  mentions: MentionLookup;
  onLongPress: () => void;
  onSwipeReply: () => void;
  /** undefined = 낙관적(tmp-) 행 — 칩 토글 비활성. */
  onToggleReaction?: (emoji: string, currentlyByMe: boolean) => void;
  customEmojiList: CustomEmoji[];
  /** 전송 실패(sendState='failed') 행의 동일 clientNonce 재시도. */
  onRetry: () => void;
}): JSX.Element {
  const pressTimer = useRef<number | null>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const [swipeOffset, setSwipeOffset] = useState(0);
  // 071-M0 C12: 커밋 판정을 state 클로저로 읽으면 같은 태스크에서 연속 발화하는 터치
  // 시퀀스(합성 이벤트·고주사율 기기)에서 touchend 가 항상 초기값 0 을 봐 스와이프가
  // 절대 커밋되지 않는다 — 판정은 ref, state 는 시각 transform 전용으로 분리한다.
  const swipeOffsetRef = useRef(0);

  const LONG_PRESS_MS = 500;
  const SWIPE_THRESHOLD_PX = 80;

  const onTouchStart = (e: TouchEvent): void => {
    const t = e.touches[0];
    // M2 리뷰 M-1: 좌 엣지(PANEL_EDGE_PX) 시작 터치는 MobilePanels 의 패널 오픈
    // 제스처에 양보한다 — 종전엔 같은 드래그가 좌 패널 + 스레드 패널을 이중
    // 커밋했다(행 스와이프 80px, 패널 60px 임계로 둘 다 통과).
    if (t.clientX <= PANEL_EDGE_PX) return;
    touchStart.current = { x: t.clientX, y: t.clientY };
    pressTimer.current = window.setTimeout(() => {
      pressTimer.current = null;
      onLongPress();
    }, LONG_PRESS_MS);
  };
  const onTouchMove = (e: TouchEvent): void => {
    if (!touchStart.current) return;
    const t = e.touches[0];
    const dx = t.clientX - touchStart.current.x;
    const dy = t.clientY - touchStart.current.y;
    // Lateral drag cancels the long-press.
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
      if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
    if (dx > 0 && Math.abs(dy) < 30) {
      const v = Math.min(dx, 120);
      swipeOffsetRef.current = v;
      setSwipeOffset(v);
    }
  };
  const onTouchEnd = (): void => {
    if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
    pressTimer.current = null;
    if (swipeOffsetRef.current >= SWIPE_THRESHOLD_PX) {
      // M2 E6: swipe-right = 스레드 답글 진입(호출측이 ThreadPanel 을 연다).
      onSwipeReply();
    }
    swipeOffsetRef.current = 0;
    setSwipeOffset(0);
    touchStart.current = null;
  };
  // M1 리뷰 L-9: 브라우저가 제스처를 회수(touchcancel — 스크롤 컨테이너 개입 등)
  // 하면 타이머/스와이프 상태만 정리한다. 답장 커밋은 의도된 touchend 전용 —
  // 정리 없이는 long-press 타이머가 살아남아 의도치 않은 시트 오픈이 가능했다.
  const onTouchCancel = (): void => {
    if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
    pressTimer.current = null;
    swipeOffsetRef.current = 0;
    setSwipeOffset(0);
    touchStart.current = null;
  };

  if (msg.deleted) {
    // S05 verify: DS 미등록 `qf-m-message` 그리드 클래스(40px 1fr)를 tombstone
    // 에 붙이면 텍스트가 40px 첫 컬럼에 끼인다. 데스크톱 tombstone(MessageItem)
    // 처럼 DS 토큰 기반 패딩만 쓰고 그리드는 피한다.
    return (
      <div
        data-testid={`mobile-msg-deleted-${msg.id}`}
        role="note"
        aria-label="삭제된 메시지"
        className="px-[var(--m-gutter)] py-[var(--s-2)] text-[length:var(--fs-15)] italic text-text-muted"
      >
        (삭제된 메시지)
      </div>
    );
  }

  // 071-M1 D1: BOT 메시지(FR-RC11)는 botUsername override + 'BOT' 뱃지. 점보 이모지
  // (FR-RC15)는 fs-32 확대. 본문은 데스크톱과 동일하게 contentAst→renderAst(멘션 pill/
  // 스포일러/헤딩/커스텀 이모지), legacy(content)→renderMessageContent 폴백.
  const isBot = msg.authorType === 'BOT';
  const effectiveAuthorName = isBot ? (msg.botUsername ?? authorName) : authorName;
  const jumbo = isJumboEmoji(msg.contentAst);
  // 071-M1 D5(FR-MSG-04/05): 낙관 행 전송 상태 — pending=흐림, failed=경고+재시도.
  const sendState = (msg as MessageDto & { sendState?: 'pending' | 'failed' }).sendState;
  // D3: 링크 미리보기 전역 설정(외관 설정과 공유 스토어).
  const linkPreviews = useLinkPreviewsEnabled();

  return (
    <article
      data-testid={`mobile-msg-${msg.id}`}
      data-mine={isMine ? 'true' : 'false'}
      // S05 verify: DS 정본은 `qf-m-msg`(+__avatar/__meta/__author/__time/__body).
      // 071-M1 D1: 그루핑 변형(--head/--cont — DS 가 cont 의 아바타/메타를 숨김) +
      // 내 멘션 행 배경 강조(--mention-bg 토큰, PRD D01 모바일 멘션 행).
      data-send-state={sendState}
      data-jump-highlight={highlighted ? 'true' : undefined}
      className={cn(
        'qf-m-msg',
        cont ? 'qf-m-msg--cont' : 'qf-m-msg--head',
        (mentionsMe || highlighted) && 'bg-[var(--mention-bg)]',
        sendState === 'pending' && 'opacity-60',
      )}
      style={{
        transform: `translateX(${swipeOffset}px)`,
        // S35 fix-forward (DS 토큰화): raw 120ms → DS duration 토큰(--dur-fast=140ms).
        transition: swipeOffset === 0 ? 'transform var(--dur-fast)' : undefined,
      }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchCancel}
    >
      <Avatar
        name={effectiveAuthorName ?? msg.authorId.slice(0, 2)}
        size="sm"
        className="qf-m-msg__avatar"
      />
      <div className="qf-m-msg__meta">
        <span className="qf-m-msg__author">{effectiveAuthorName ?? 'unknown'}</span>
        {isBot ? (
          <span data-testid={`mobile-msg-bot-${msg.id}`} className="qf-badge qf-badge--accent">
            BOT
          </span>
        ) : null}
        <time className="qf-m-msg__time">
          {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </time>
        {msg.edited ? (
          // S05 (FR-MSG-07) 모바일 parity: (수정됨) 뱃지. 데스크톱 MessageItem
          // 과 동일하게 시각 토큰(qf-m-msg__time)을 재사용하고 editedAt 을 title 로.
          <span
            data-testid={`mobile-msg-edited-${msg.id}`}
            className="qf-m-msg__time"
            title={msg.editedAt ? new Date(msg.editedAt).toLocaleString() : undefined}
          >
            (수정됨)
          </span>
        ) : null}
      </div>
      <div
        className={cn(
          'qf-m-msg__body',
          jumbo && 'text-[length:var(--fs-32)] leading-[var(--lh-tight)]',
        )}
        data-jumbo={jumbo ? 'true' : undefined}
      >
        {msg.contentAst
          ? renderAst(msg.contentAst, customEmojiByName, mentions)
          : renderMessageContent(msg.content ?? '', customEmojiByName)}
        {sendState === 'failed' ? (
          <div
            data-testid={`mobile-msg-send-failed-${msg.id}`}
            className="mt-1 flex items-center gap-[var(--s-2)] text-[length:var(--fs-12)]"
          >
            <span role="alert" className="text-[color:var(--danger-400)]">
              전송 실패
            </span>
            <button
              type="button"
              data-testid={`mobile-msg-retry-${msg.id}`}
              onClick={onRetry}
              className="qf-btn qf-btn--ghost qf-btn--sm"
            >
              다시 시도
            </button>
          </div>
        ) : null}
      </div>
      {/* D3(FR-AM-07/09): 첨부 그리드 + 내장 라이트박스. */}
      {(msg.attachments?.length ?? 0) > 0 ? (
        <div className="col-start-2">
          <AttachmentsList attachments={msg.attachments ?? []} />
        </div>
      ) : null}
      {/* D3(FR-RC07/08): 서버 unfurl embed 우선, 없으면 본문 URL lazy-fetch 폴백 —
          데스크톱 MessageItem 과 동일 분기(전역 링크 미리보기 설정 존중). */}
      {linkPreviews
        ? (() => {
            const serverEmbeds = msg.embeds ?? [];
            if (serverEmbeds.length > 0) {
              return (
                <div className="col-start-2">
                  {serverEmbeds.map((e) => (
                    <LinkPreview key={`embed-${e.id}`} embed={e} />
                  ))}
                </div>
              );
            }
            const urls = extractMessageUrls(msg.content ?? '');
            return urls.length > 0 ? (
              <div className="col-start-2">
                {urls.map((u) => (
                  <LinkPreview key={`embed-${u}`} url={u} />
                ))}
              </div>
            ) : null;
          })()
        : null}
      {/* D3(FR-RC12): 봇/웹훅 rich embed. */}
      {(msg.richEmbeds?.length ?? 0) > 0 ? (
        <div className="col-start-2">
          <RichEmbeds embeds={msg.richEmbeds} />
        </div>
      ) : null}
      {/* 071-M1 D2(FR-RE01/02/03): 리액션 칩 행 — 데스크톱 ReactionBar 재사용.
          모바일 44px 터치 플로어는 mobile-touch-target.css 가 .qf-reaction 에 보장. */}
      {onToggleReaction && (msg.reactions?.length ?? 0) > 0 ? (
        <div className="col-start-2">
          <ReactionBar
            reactions={msg.reactions ?? []}
            onToggle={onToggleReaction}
            customEmojis={customEmojiList.map((ce) => ({ id: ce.id, name: ce.name, url: ce.url }))}
          />
        </div>
      ) : null}
    </article>
  );
}

function MobileComposer({
  workspaceId,
  channelId,
  channelName,
  send,
  inputRef,
}: {
  /** null = Global DM — presign 이 ws 스코프라 첨부 비활성. */
  workspaceId: string | null;
  channelId: string;
  channelName: string;
  send: (content: string, attachmentIds?: string[], bulkMentionConfirmed?: boolean) => void;
  inputRef: RefObject<HTMLTextAreaElement>;
}): JSX.Element {
  const draft = useCompose((s) => s.drafts[channelId] ?? '');
  const setDraft = useCompose((s) => s.setDraft);
  const clearDraft = useCompose((s) => s.clearDraft);

  // D8(b/c/e): 자동완성 소스·특수멘션 게이트·공지 게시 제한에 쓰는 워크스페이스
  // 데이터. 부모(MobileMessages)와 같은 쿼리 키라 react-query 캐시를 공유한다
  // (DM=workspaceId null 이면 전부 비활성 — 자동완성도 enabled=false).
  const { user } = useAuth();
  const { data: membersData } = useMembers(workspaceId ?? undefined);
  const { data: wsData } = useWorkspace(workspaceId ?? undefined);
  const { data: rolesData } = useRoles(workspaceId ?? undefined);
  const { data: channelData } = useChannelList(workspaceId ?? undefined);
  const { data: customEmojiData } = useCustomEmojis(workspaceId ?? null);
  const { onlineUserIds, dndUserIds } = usePresence(workspaceId ?? undefined);
  // 071-M2 E6 (FR-SC 모바일): 슬래시 커맨드 — 목록(자동완성 후보)·서버 실행·
  // EPHEMERAL 스토어·GIPHY 프리뷰·클라 액션 의존성. 전부 데스크톱 모듈 재사용.
  const { data: slashCommandData } = useSlashCommands(workspaceId);
  const ephemeral = useEphemeralMessages(channelId);
  const setGiphyPreview = useGiphyPreviewStore((st) => st.set);
  const setMediaCollapsed = useMediaCollapseStore((st) => st.setCollapsed);
  const { toggle: toggleTheme, resolved: resolvedTheme } = useTheme();
  const navigate = useNavigate();

  const myRole: WorkspaceRole =
    wsData?.myRole ??
    (membersData?.members.find((m) => m.userId === user?.id)?.role as WorkspaceRole | undefined) ??
    'MEMBER';
  const memberCount = membersData?.members.length ?? 0;

  // D8(c)(FR-CH-19): ANNOUNCEMENT 채널은 OWNER/ADMIN 만 게시. 권한 비트 오버라이드는
  // 서버가 최종 판정(403)하며 여기는 역할 기본값 기준의 UX 게이트만 둔다(데스크톱
  // MessageColumn 과 동일 규칙 — 서버가 단일 진실원).
  const channelType = useMemo(() => {
    if (!channelData) return null;
    const flat = [
      ...channelData.uncategorized,
      ...channelData.categories.flatMap((c) => c.channels),
    ];
    return flat.find((c) => c.id === channelId)?.type ?? null;
  }, [channelData, channelId]);
  const canManage = myRole === 'OWNER' || myRole === 'ADMIN';
  const postingRestricted = workspaceId !== null && channelType === 'ANNOUNCEMENT' && !canManage;
  // F6: 슬로우모드 — 같은 채널 lookup 에서 초를 읽는다. OWNER/ADMIN 은 통상 면제
  // (서버 BYPASS 비트가 최종 권위 — 보수적으로 관리자만 클라 카운트 제외).
  const slowmodeSeconds = useMemo(() => {
    if (!channelData) return 0;
    const flat = [
      ...channelData.uncategorized,
      ...channelData.categories.flatMap((c) => c.channels),
    ];
    return flat.find((c) => c.id === channelId)?.slowmodeSeconds ?? 0;
  }, [channelData, channelId]);
  const slowmode = useSlowmodeCooldown(canManage ? 0 : slowmodeSeconds);

  // D8(d)(FR-IA-STATE-05a): 오프라인이면 컴포저 비활성. navigator.onLine 신호는
  // ConnectionBanner 와 동일 소스 — 배너가 사유를 고지하고 컴포저는 입력만 막는다.
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  useEffect(() => {
    const handleOnline = (): void => setOnline(true);
    const handleOffline = (): void => setOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // D4(FR-AM-01): 업로드 트레이 — 데스크톱 파이프라인 재사용. 채널 전환 시 reset.
  const pushToast = useNotifications((s) => s.push);
  const tray = useAttachmentUpload(workspaceId, channelId, (t) => pushToast(t));
  const fileInputRef = useRef<HTMLInputElement>(null);
  const trayResetRef = useRef(tray.reset);
  trayResetRef.current = tray.reset;
  useEffect(() => {
    return () => trayResetRef.current();
  }, [channelId]);
  const [sending, setSending] = useState(false);
  const onFiles = (files: FileList | File[] | null): void => {
    if (!files) return;
    const incoming = Array.from(files);
    if (incoming.length === 0) return;
    const { accepted, rejected, truncated } = clampAttachments({
      currentCount: tray.items.length,
      incoming,
    });
    if (truncated) {
      pushToast({
        variant: 'warning',
        title: '첨부 파일 한도',
        body: `최대 ${MAX_ATTACHMENTS}개까지 첨부할 수 있습니다. ${rejected}개를 무시했습니다.`,
        ttlMs: 4000,
      });
    }
    if (accepted.length > 0) tray.addFiles(accepted);
  };

  // D7(FR-RT-08): 입력 → typing:start(스로틀)/idle-stop. 채널 전환·언마운트 시 stop.
  // emit 시점에 소켓을 재조회하므로 재연결에도 안전(데스크톱 makeTypingEmitter 동일).
  const typingRef = useRef<TypingEmitter | null>(null);
  useEffect(() => {
    const emitter = new TypingEmitter({
      emitStart: () => {
        const socket = getSocket();
        if (socket?.connected) socket.emit(WS_EVENTS.TYPING_START, { channelId });
      },
      emitStop: () => {
        const socket = getSocket();
        if (socket?.connected) socket.emit(WS_EVENTS.TYPING_STOP, { channelId });
      },
    });
    typingRef.current = emitter;
    return () => {
      emitter.stop();
      typingRef.current = null;
    };
  }, [channelId]);

  // D8(FR-RC02): 길이 카운터 — 경고 구간부터 노출, 초과 시 전송 차단.
  const counter = computeCounter(draft);

  // D8(e): 캐럿 추적 — detectTrigger 입력. 채널 전환 시 새 draft 끝으로 동기화해
  // 이전 채널의 트리거가 잔류하지 않게 한다(데스크톱 동일 패턴, ref 로 읽어
  // 매 키 입력마다 끝으로 튀지 않게 함).
  const [caret, setCaret] = useState(0);
  const draftLenRef = useRef(draft.length);
  draftLenRef.current = draft.length;
  useEffect(() => {
    setCaret(draftLenRef.current);
  }, [channelId]);

  const acMembers = useMemo<RankableMember[]>(
    () =>
      (membersData?.members ?? [])
        .filter((m) => m.userId !== user?.id)
        .map((m) => ({ userId: m.userId, username: m.user.username })),
    [membersData, user?.id],
  );
  const acChannels = useMemo<RankableChannel[]>(() => {
    if (!channelData) return [];
    const flat = [
      ...channelData.uncategorized,
      ...channelData.categories.flatMap((c) => c.channels),
    ];
    return flat.map((c) => ({ id: c.id, name: c.name, topic: c.topic ?? null }));
  }, [channelData]);
  const acCustomEmojis = useMemo<EmojiCandidate[]>(() => {
    const out: EmojiCandidate[] = [];
    for (const ce of customEmojiData?.items ?? []) {
      out.push({ kind: 'custom', name: ce.name, url: ce.url });
      for (const alias of ce.aliases ?? []) {
        out.push({ kind: 'custom', name: alias, url: ce.url, insertName: ce.name });
      }
    }
    return out;
  }, [customEmojiData]);
  const acOnline = useMemo(
    () => new Set<string>([...onlineUserIds, ...dndUserIds]),
    [onlineUserIds, dndUserIds],
  );
  const acRoles = useMemo<RoleCandidate[]>(
    () =>
      (rolesData ?? []).map((r) => ({
        id: r.id,
        name: r.name,
        colorHex: r.colorHex,
        mentionable: r.mentionable,
      })),
    [rolesData],
  );
  const acSources = useMemo<AutocompleteSources>(
    () => ({
      members: acMembers,
      channels: acChannels,
      customEmojis: acCustomEmojis,
      // 071-M2 E6: M1 D8(e)의 슬래시 보류 해제 — 실행 표면(EPHEMERAL 리스트·
      // GIPHY 슬롯·클라 액션)이 이번 슬라이스에서 배선됐다.
      slashCommands: slashCommandData ?? [],
      online: acOnline,
      recentMembers: [],
      recentEmojis: [],
      role: myRole,
      roles: acRoles,
    }),
    [acMembers, acChannels, acCustomEmojis, slashCommandData, acOnline, myRole, acRoles],
  );

  const {
    state: acState,
    move: acMove,
    setActiveIndex: acSetActive,
    activeRow: acActiveRow,
    close: acClose,
  } = useAutocomplete({
    text: draft,
    caret,
    sources: acSources,
    // Global DM(workspaceId=null)은 멘션/채널 네임스페이스가 없어 끈다.
    enabled: workspaceId !== null,
  });
  const listboxId = useId();
  const optionId = (index: number): string => `${listboxId}-opt-${index}`;
  const acMaxHeight = useAutocompleteMaxHeight(acState.open);

  // 데스크톱 S18 BLOCKER 가드 동일: acState.trigger 는 debounce 스냅샷 기준이라
  // 삽입 직전 live draft/caret 으로 detectTrigger 를 동기 재실행해 범위를 다시 구한다.
  const applyAutocompleteRow = (row: AutocompleteRow): void => {
    if (!acState.open) return;
    const el = inputRef.current;
    const liveCaret = el?.selectionStart ?? caret;
    const liveTrigger = detectTrigger(draft, liveCaret);
    if (!liveTrigger) {
      acClose();
      return;
    }
    const token = tokenForRow(row);
    const r = insertToken({ text: draft, start: liveTrigger.start, end: liveTrigger.end, token });
    setDraft(channelId, r.text);
    acClose();
    queueMicrotask(() => {
      const node = inputRef.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(r.caret, r.caret);
      setCaret(r.caret);
      // 프로그램적 삽입은 onChange 를 타지 않으므로 autogrow 를 직접 재계산한다.
      node.style.height = 'auto';
      node.style.height = `${node.scrollHeight}px`;
    });
  };

  // D8(b)(FR-MSG-14): 대규모 특수멘션 confirm — 데스크톱과 동일 게이트.
  // 권한 없으면 서버가 fanout 을 무효화(FR-MSG-15)하므로 confirm 도 띄우지 않는다.
  const [pendingSpecial, setPendingSpecial] = useState<SpecialMentionKey | null>(null);
  const findSpecialNeedingConfirm = (text: string): SpecialMentionKey | null => {
    const lower = text.toLowerCase();
    const keys: SpecialMentionKey[] = ['everyone', 'here', 'channel'];
    for (const key of keys) {
      const re = new RegExp(`(?<![A-Za-z0-9_])@${key}(?![A-Za-z0-9_])`);
      if (!re.test(lower)) continue;
      if (!canUseSpecialMention(key, myRole)) continue;
      if (needsSpecialMentionConfirm(key, memberCount)) return key;
    }
    return null;
  };

  const resetInputHeight = (): void => {
    const el = inputRef.current;
    if (el) el.style.height = 'auto';
  };

  // 071-M2 E6 (FR-SC-04·05·06 모바일): 서버 슬래시 실행 — 데스크톱 runSlashExecution
  // 포팅. IN_CHANNEL=게시(WS 가 표시), GIPHY_PREVIEW=발신자 전용 프리뷰 슬롯,
  // EPHEMERAL=인라인 시스템 행(에러면 draft 유지). navigate 지시(dm/channel)도 처리.
  const finishSlash = (): void => {
    clearDraft(channelId);
    setPendingSpecial(null);
    typingRef.current?.stop();
    resetInputHeight();
  };
  const runSlashExecution = (command: string, text: string): void => {
    if (workspaceId === null) return; // DM 은 슬래시 비범위(자동완성도 꺼짐).
    setSending(true);
    void executeSlashCommand({
      workspaceId,
      channelId,
      command,
      text,
      idempotencyKey: crypto.randomUUID(),
    })
      .then((res) => {
        if (res.responseType === 'IN_CHANNEL') {
          finishSlash();
          return;
        }
        if (res.responseType === 'GIPHY_PREVIEW') {
          setGiphyPreview({
            channelId,
            gifUrl: res.gifUrl,
            gifThumbUrl: res.gifThumbUrl,
            title: res.title,
            keyword: res.keyword,
            offset: res.offset,
          });
          finishSlash();
          return;
        }
        const isError = res.error === true;
        ephemeral.push(res.content, isError);
        if (!isError) {
          finishSlash();
          if (res.navigate?.kind === 'dm') navigate(`/dms/${res.navigate.userId}`);
          if (res.navigate?.kind === 'channel') {
            navigate(`/w/${res.navigate.slug}/${res.navigate.channelName}`);
          }
        }
      })
      .catch((err: unknown) => {
        const message =
          err && typeof err === 'object' && 'message' in err
            ? String((err as { message: unknown }).message)
            : '슬래시 커맨드 실행에 실패했습니다';
        ephemeral.push(message, true);
      })
      .finally(() => setSending(false));
  };

  // 071-M2 E6 (FR-SC-08 모바일): 클라이언트 전용 커맨드 — 모바일 안전 매핑.
  // collapse/expand·darkmode 는 데스크톱과 동일 스토어, /search 는 검색 탭으로
  // 이동(쿼리 pre-fill), /shortcuts 는 키보드 단축키 표면이 없어 안내만.
  const runClientSlashAction = (action: ClientSlashAction): void => {
    let confirmText: string;
    switch (action.kind) {
      case 'collapseMedia':
        setMediaCollapsed(channelId, true);
        confirmText = '이 채널의 인라인 미디어를 접었습니다';
        break;
      case 'expandMedia':
        setMediaCollapsed(channelId, false);
        confirmText = '이 채널의 인라인 미디어를 펼쳤습니다';
        break;
      case 'openSearch':
        finishSlash();
        navigate(
          action.query.length > 0 ? `/search?q=${encodeURIComponent(action.query)}` : '/search',
        );
        return;
      case 'openShortcuts':
        confirmText = '키보드 단축키는 데스크톱에서 제공됩니다';
        break;
      case 'toggleTheme':
        confirmText =
          resolvedTheme === 'dark' ? '라이트 모드로 전환했습니다' : '다크 모드로 전환했습니다';
        toggleTheme();
        break;
    }
    ephemeral.push(confirmText, false);
    finishSlash();
  };

  const submit = (bulkMentionConfirmed = false): void => {
    const trimmed = draft.trim();
    const hasAttachments = tray.items.length > 0;
    if (!trimmed && !hasAttachments) return;
    if (!counter.canSend) return;
    if (slowmode.remainingSec > 0) return; // F6: 쿨다운 중 전송 차단.
    if (tray.uploadingCount > 0 || sending) return;
    // D4(FR-AM-24 미러): 실패 첨부 잔존 시 전송 차단 — 무언 유실 방지(데스크톱 동일).
    if (tray.failedCount > 0) {
      pushToast({
        variant: 'warning',
        title: '업로드 실패한 첨부가 있습니다',
        body: '실패한 첨부를 제거하거나 다시 시도해 주세요.',
        ttlMs: 6000,
      });
      return;
    }
    // 071-M2 E6 (FR-SC-04): 슬래시 실행 분기 — 첨부 없는 텍스트 전용(데스크톱 동일).
    // 리뷰 L-6: DM(workspaceId=null)은 분기 자체를 건너뛰어 일반 전송으로 폴백
    // (슬래시 목록도 비어 있어 detect 가 null 이지만, 무음 소실 경로를 봉인).
    if (!hasAttachments && workspaceId !== null) {
      const slash = detectSlashExecution(trimmed, slashCommandData ?? []);
      if (slash) {
        const clientAction = detectClientSlashAction(slash.command, slash.text);
        if (clientAction) {
          runClientSlashAction(clientAction);
          return;
        }
        runSlashExecution(slash.command, slash.text);
        return;
      }
    }
    // D8(b)(FR-MN-16 미러): 권한 없는 특수멘션은 "알림이 안 갈 수 있음"을 고지하고
    // 그대로 전송한다(서버 게이트가 fanout 만 무효화 — 데스크톱 S44 동일 불확정 카피).
    const unauthorized = firstUnauthorizedSpecialMention(draft, myRole);
    if (unauthorized) {
      pushToast({
        variant: 'warning',
        title: `@${unauthorized} 권한이 없을 수 있습니다`,
        body: '이 채널에서 해당 멘션 알림 권한이 없으면 알림이 가지 않을 수 있습니다.',
        ttlMs: 6000,
      });
    }
    // D8(b)(FR-MSG-14): 대규모 특수멘션이면 먼저 confirm dialog 를 띄운다.
    if (!bulkMentionConfirmed) {
      const needsConfirm = findSpecialNeedingConfirm(trimmed);
      if (needsConfirm) {
        setPendingSpecial(needsConfirm);
        return;
      }
    }
    if (!hasAttachments) {
      send(trimmed, undefined, bulkMentionConfirmed);
      slowmode.markSent();
      clearDraft(channelId);
      setPendingSpecial(null);
      typingRef.current?.stop();
      resetInputHeight();
      return;
    }
    setSending(true);
    void tray
      .completeAndCollect()
      .then((attachmentIds) => {
        if (attachmentIds.length === 0) return; // complete 실패 — 훅이 토스트, draft 유지.
        send(trimmed || ' ', attachmentIds, bulkMentionConfirmed);
        slowmode.markSent();
        tray.clearConfirmed();
        clearDraft(channelId);
        setPendingSpecial(null);
        typingRef.current?.stop();
        resetInputHeight();
      })
      .finally(() => setSending(false));
  };

  // D8(c)(FR-CH-19): 게시 권한 없는 ANNOUNCEMENT 채널 — 입력 자체를 비활성화하고
  // 사유를 placeholder 로 고지한다(데스크톱 composer-posting-restricted 동일 의미).
  if (postingRestricted) {
    return (
      <div className="qf-m-safe-bottom">
        <div data-testid="mobile-composer-restricted" className="qf-m-composer cursor-not-allowed">
          <Icon name="megaphone" size="md" className="text-text-muted" />
          <textarea
            rows={1}
            disabled
            aria-label="이 채널은 관리자만 게시할 수 있습니다"
            placeholder="이 채널은 관리자만 게시할 수 있습니다"
            className="qf-m-composer__input cursor-not-allowed"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="qf-m-safe-bottom">
      {/* 071-M2 E6 (M1 리뷰 M-4): replyTarget 배너 폐기 — '답장'은 스레드 답글
          단일 경로(시트/스와이프가 ThreadPanel 을 연다). */}
      {/* F6(FR-CH-23): 슬로우모드 쿨다운 — 잔여 초 표시. */}
      {slowmode.remainingSec > 0 ? (
        <div
          data-testid="mobile-slowmode-cooldown"
          aria-live="polite"
          className="px-[var(--s-4)] py-[var(--s-1)] text-right text-[length:var(--fs-11)] text-text-muted"
        >
          슬로우모드 — {slowmode.remainingSec}초 후 전송 가능
        </div>
      ) : null}
      {/* D8(FR-RC02): 한도 근접/초과 카운터 — 경고 구간부터 노출. */}
      {counter.shouldShow ? (
        <div
          data-testid="mobile-composer-counter"
          aria-live="polite"
          className={cn(
            'px-[var(--s-4)] py-[var(--s-1)] text-right text-[length:var(--fs-11)]',
            counter.overLimit ? 'text-[color:var(--danger-400)]' : 'text-text-muted',
          )}
        >
          {counter.remaining.toLocaleString()}자 남음
        </div>
      ) : null}
      {/* D4: 업로드 트레이(진행/실패/ALT/스포일러) — 데스크톱 컴포넌트 재사용. */}
      <AttachmentTray
        items={tray.items}
        onRemove={tray.removeItem}
        onRetry={tray.retryItem}
        onAltChange={tray.setAltText}
        onToggleSpoiler={tray.toggleSpoiler}
      />
      <form
        data-testid="mobile-composer"
        // D8(e): relative — .qf-autocomplete(absolute, bottom:100%)가 컴포저 전체
        // 폭을 기준으로 바로 위에 뜨도록 anchor 를 form 으로 둔다.
        className="qf-m-composer relative"
        data-offline={online ? undefined : 'true'}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {/* D8(e)(FR-RC03/04/05): @멘션/#채널/:이모지 자동완성 — 데스크톱 listbox UI
            재사용. 터치 탭(onMouseDown 에뮬레이션)·하드웨어 키보드(Tab/화살표) 모두
            삽입 가능. 팝업 maxHeight 는 visualViewport(소프트 키보드) 보정. */}
        {acState.open ? (
          <Autocomplete
            kind={acState.kind}
            rows={acState.rows}
            activeIndex={acState.activeIndex}
            listboxId={listboxId}
            optionId={optionId}
            maxHeight={acMaxHeight}
            onSelect={(index) => {
              const row = acState.rows[index];
              if (row) applyAutocompleteRow(row);
            }}
            onHover={(index) => acSetActive(index)}
          />
        ) : null}
        {/* D4(FR-AM-01): 종전 onClick 미배선 죽은 컨트롤 → 파일 선택 배선.
            DM(workspaceId=null)은 presign 스코프상 미지원 — 안내 토스트. */}
        <button
          type="button"
          data-testid="mobile-composer-plus"
          aria-label="첨부 추가"
          aria-disabled={workspaceId === null ? 'true' : undefined}
          disabled={!online}
          className="qf-m-composer__plus"
          onClick={() => {
            if (workspaceId === null) {
              pushToast({
                variant: 'info',
                title: 'DM 첨부는 아직 지원되지 않습니다',
                ttlMs: 3000,
              });
              return;
            }
            fileInputRef.current?.click();
          }}
        >
          <Icon name="plus-circle" size="md" />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          aria-label="파일 첨부"
          data-testid="mobile-composer-file-input"
          onChange={(e) => {
            onFiles(e.target.files);
            e.target.value = ''; // 같은 파일 재선택 허용.
          }}
        />
        {/* D8(FR-RC01 모바일·FR-MSG-01): 멀티라인 textarea(autogrow, DS max-height 120px).
            모바일 소프트 키보드의 Enter 는 줄바꿈(071 M4 PRD 개정 방향), 전송은 버튼 또는
            하드웨어 Ctrl/Cmd+Enter. */}
        <textarea
          ref={inputRef}
          rows={1}
          data-testid="mobile-msg-input"
          aria-label="메시지 입력"
          className="qf-m-composer__input"
          enterKeyHint="enter"
          value={draft}
          // D8(d)(FR-IA-STATE-05a): 오프라인이면 입력 비활성(전송 버튼·+버튼 동반).
          disabled={!online}
          // D8(e): WAI-ARIA Combobox(activedescendant) — 포커스는 textarea 유지,
          // active 항목만 aria-activedescendant 로 가리킨다(데스크톱 동일).
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={acState.open}
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-activedescendant={
            acState.open && acState.activeIndex >= 0 ? optionId(acState.activeIndex) : undefined
          }
          onChange={(e) => {
            setDraft(channelId, e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            // autogrow — CSS max-height(120px)가 상한을 클램프.
            e.target.style.height = 'auto';
            e.target.style.height = `${e.target.scrollHeight}px`;
            // D7: 비움은 즉시 stop, 입력은 스로틀된 start.
            if (e.target.value.trim() === '') typingRef.current?.stop();
            else typingRef.current?.onInput();
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onClick={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onKeyUp={(e) => {
            // 방향키/Home/End 등 캐럿 이동도 트리거 재평가에 반영한다.
            setCaret(e.currentTarget.selectionStart ?? 0);
          }}
          placeholder={!online ? '오프라인 — 연결되면 보낼 수 있습니다' : `# ${channelName}`}
          onKeyDown={(e) => {
            const native = e.nativeEvent as KeyboardEvent & { isComposing?: boolean };
            if (native.isComposing || e.keyCode === 229) return;
            // D8(e): 팝업이 열려 있으면 화살표/Tab/Esc 를 먼저 처리한다.
            // Enter 는 가로채지 않는다 — 모바일 Enter=줄바꿈 정책(071 M4) 유지,
            // 삽입은 터치 탭 또는 Tab(하드웨어 키보드)으로 한다.
            if (acState.open) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                acMove('down');
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                acMove('up');
                return;
              }
              if (e.key === 'Tab') {
                if (acActiveRow) {
                  e.preventDefault();
                  applyAutocompleteRow(acActiveRow);
                } else {
                  acClose();
                }
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                acClose();
                return;
              }
            }
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button
          type="submit"
          data-testid="mobile-composer-send"
          aria-label="전송"
          className="qf-m-composer__send"
          disabled={
            (draft.trim().length === 0 && tray.items.length === 0) ||
            counter.overLimit ||
            tray.uploadingCount > 0 ||
            sending ||
            slowmode.remainingSec > 0 ||
            !online
          }
        >
          <Icon name="send" size="md" />
        </button>
      </form>
      {/* D8(b)(FR-MSG-14): 대규모 특수멘션 클라 선제 confirm. 확인 시
          bulkMentionConfirmed=true 로 전송해 서버 임계값(S94)도 통과시킨다. */}
      <SpecialMentionConfirmDialog
        open={pendingSpecial !== null}
        mentionKey={pendingSpecial}
        onConfirm={() => {
          setPendingSpecial(null);
          submit(true);
        }}
        onCancel={() => setPendingSpecial(null)}
      />
    </div>
  );
}
