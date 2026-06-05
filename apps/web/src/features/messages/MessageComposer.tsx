import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { WS_EVENTS } from '@qufox/shared-types';
import { useSendMessage } from './useMessages';
import { TypingEmitter } from '../typing/typingEmitter';
import { useCompose } from '../../stores/compose-store';
import { getSocket } from '../../lib/socket';
import { useNotifications } from '../../stores/notification-store';
import {
  DropdownRoot,
  DropdownTrigger,
  DropdownContent,
  DropdownItem,
  Icon,
  Tooltip,
} from '../../design-system/primitives';
import { EmojiPicker } from '../reactions/EmojiPicker';
import { useCustomEmojis } from '../emojis/useCustomEmojis';
import { useMembers, useWorkspace } from '../workspaces/useWorkspaces';
import { useAuth } from '../auth/AuthProvider';
import { useChannelList } from '../channels/useChannels';
import { usePresence } from '../realtime/usePresence';
import { useAttachmentUpload } from '../attachments/useAttachmentUpload';
import { AttachmentTray } from '../attachments/AttachmentTray';
import { clampAttachments, MAX_ATTACHMENTS } from './clampAttachments';
import { computeCounter } from './composerCounter';
import { composerAnnouncement } from './composerAnnouncement';
import { announce } from '../../lib/a11y-announce';
import { cn } from '../../lib/cn';
import { Autocomplete } from './autocomplete/Autocomplete';
import { SpecialMentionConfirmDialog } from './autocomplete/SpecialMentionConfirmDialog';
import {
  useAutocomplete,
  type AutocompleteRow,
  type AutocompleteSources,
} from './autocomplete/useAutocomplete';
import { insertToken } from './autocomplete/insertToken';
import { detectTrigger } from './autocomplete/detectTrigger';
import { useAutocompleteMaxHeight } from './autocomplete/popupMaxHeight';
import {
  canUseSpecialMention,
  firstUnauthorizedSpecialMention,
  needsSpecialMentionConfirm,
  type SpecialMentionKey,
  type WorkspaceRole,
} from './autocomplete/specialMention';
import type { RankableMember } from './autocomplete/rankMembers';
import type { RankableChannel } from './autocomplete/filterChannels';
import type { EmojiCandidate } from './autocomplete/filterEmojis';
import { useSlashCommands } from './slashCommands/useSlashCommands';
import { executeSlashCommand } from './slashCommands/api';
import { useEphemeralMessages } from './slashCommands/useEphemeralMessages';
import { useGiphyPreviewStore } from './slashCommands/useGiphyPreview';
import {
  detectClientSlashAction,
  detectSlashExecution,
  paramHintForRow,
  slashToken,
  type ClientSlashAction,
} from './composerSlash';
// S81a (FR-SC-08): 클라이언트 전용 슬래시 커맨드(collapse/expand/search/shortcuts/darkmode).
import { useMediaCollapseStore } from './mediaCollapseStore';
import { useUI } from '../../stores/ui-store';
import { useTheme } from '../../design-system/theme/ThemeProvider';
// S81a (FR-SC-08): /msg 응답의 navigate(DM 으로 이동) 처리.
import { useNavigate } from 'react-router-dom';

type Props = {
  /** null for Global DM channels — custom emoji picker is empty then. */
  workspaceId: string | null;
  channelId: string;
  channelName: string;
  /**
   * S13 (FR-CH-19): ANNOUNCEMENT 채널에서 게시 권한이 없는 사용자에게는
   * composer 를 비활성화한다. true 일 때 입력·전송·첨부가 모두 막히고
   * 안내 placeholder + 툴팁을 표시한다.
   */
  postingRestricted?: boolean;
};

// Single-line initial height (matches the DS composer mockup's
// `qf-input` one-row shape). Grows with content up to 200px, then
// scrolls internally.
const MIN_HEIGHT_PX = 22;
const MAX_HEIGHT_PX = 200;

/**
 * S32 (FR-RT-08): 주어진 channelId 로 콜론 이벤트를 emit 하는 TypingEmitter 를
 * 만듭니다. emit 시점에 socket 을 다시 조회하므로 재연결에도 안전합니다.
 */
function makeTypingEmitter(channelId: string): TypingEmitter {
  return new TypingEmitter({
    emitStart: () => {
      const socket = getSocket();
      if (socket?.connected) socket.emit(WS_EVENTS.TYPING_START, { channelId });
    },
    emitStop: () => {
      const socket = getSocket();
      if (socket?.connected) socket.emit(WS_EVENTS.TYPING_STOP, { channelId });
    },
  });
}

/**
 * S18 (FR-RC06): 선택된 자동완성 행을 컴포저에 삽입할 토큰으로 변환.
 *   - 멤버/특수멘션 → `@username` / `@everyone`
 *   - 채널          → `#name`
 *   - 이모지        → 유니코드 글리프 또는 `:name:`(커스텀)
 */
function tokenForRow(row: AutocompleteRow): string {
  if (row.type === 'special') return row.item.token;
  if (row.type === 'member') return `@${row.member.username}`;
  if (row.type === 'channel') return `#${row.channel.name}`;
  // S79 (FR-SC-03): 슬래시 커맨드 선택 시 `/커맨드명` 을 삽입한다(insertToken 이 공백을
  // 덧붙여 `/name ` 형태로 파라미터 입력을 이어가게 한다). 실행은 S80.
  if (row.type === 'slash') return slashToken(row.command.name);
  if (row.emoji.kind === 'unicode') return row.emoji.glyph;
  // S42 (FR-PK02): 별칭 후보면 카노니컬 이름(insertName)으로 삽입한다. 일반 커스텀
  // 후보는 name 자체가 카노니컬이라 insertName 이 없다.
  return `:${row.emoji.insertName ?? row.emoji.name}:`;
}

/** insertToken 래퍼 — caret 키 이름을 컴포저 로컬 표기에 맞춘다. */
function applyToken(
  text: string,
  start: number,
  end: number,
  token: string,
): { text: string; caretPos: number } {
  const r = insertToken({ text, start, end, token });
  return { text: r.text, caretPos: r.caret };
}

export function MessageComposer({
  workspaceId,
  channelId,
  channelName,
  postingRestricted = false,
}: Props): JSX.Element {
  const draft = useCompose((s) => s.drafts[channelId] ?? '');
  const setDraft = useCompose((s) => s.setDraft);
  const clearDraft = useCompose((s) => s.clearDraft);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // S32 (FR-RT-08): typing:start 3초 스로틀 + 10초 idle 자동 stop 상태 머신.
  // 채널별로 새 인스턴스를 만들어 이전 채널의 타이머/상태가 누수되지 않게 합니다.
  // emit 콜백은 콜론 이벤트(typing:start/typing:stop)로 현재 채널에 보냅니다.
  //
  // S32 (perf R-5): ref 초기값은 null 로만 두고, 실제 emitter 생성은 아래
  // channelId useEffect 한 곳에서만 합니다. 종전엔 render-phase 에서 한 번
  // makeTypingEmitter 로 채워 둔 인스턴스가 직후 useEffect 에서 곧바로 새 것으로
  // 교체돼 redundant 했습니다(첫 마운트마다 emitter 1개 낭비). onInput/stop 콜백은
  // optional chaining 으로 호출하므로, 첫 렌더~첫 effect 사이의 짧은 null 구간은
  // 무해합니다(그 사이 사용자 입력이 들어올 수 없음).
  const typingEmitterRef = useRef<TypingEmitter | null>(null);
  const { send, mutation } = useSendMessage(workspaceId, channelId);
  const notify = useNotifications((s) => s.push);
  const { data: customEmojiData } = useCustomEmojis(workspaceId);
  const [emojiOpen, setEmojiOpen] = useState(false);

  // S56 (D11 / FR-AM-02/22): 3단계 업로드 트레이. 항목별 진행률/상태/alt/spoiler 를
  // 훅이 관리하고, 전송 시 completeAndCollect 가 READY 항목을 complete 해
  // attachmentIds 를 모은다(sortOrder = 트레이 인덱스). 토스트는 notify 로 위임.
  const tray = useAttachmentUpload(workspaceId, channelId, (t) =>
    notify({ variant: t.variant, title: t.title, body: t.body, ttlMs: 6000 }),
  );
  const trayItems = tray.items;
  const uploading = tray.uploadingCount;
  const failedAttachments = tray.failedCount;
  // 클램프 race 가드: 현재 트레이 항목 수를 ref 로 읽어 연속 드롭/선택을 직렬화한다.
  const trayCountRef = useRef(trayItems.length);
  useEffect(() => {
    trayCountRef.current = trayItems.length;
  }, [trayItems.length]);
  // complete 진행 중 중복 전송 방지.
  const [sending, setSending] = useState(false);

  useEffect(() => {
    textareaRef.current?.focus();
    tray.reset();
    setEmojiOpen(false);
    // channelId 전환 시에만 트레이를 비운다(tray.reset 은 안정 콜백).
  }, [channelId]);

  // task-047 iter5 (O1): channel empty state CTA → composer 포커스.
  // SearchInput 와 동일 패턴 (qufox.search.focus).
  useEffect(() => {
    const onFocus = (): void => {
      textareaRef.current?.focus();
    };
    window.addEventListener('qufox.composer.focus', onFocus);
    return () => window.removeEventListener('qufox.composer.focus', onFocus);
  }, []);

  // S56 (D11 / FR-AM-01/21): MessageColumn 의 드롭/붙여넣기가 파일을 dispatch 하면
  // 컴포저의 onFiles(클램프 포함)로 받는다(qufox.composer.focus 와 동일 DOM 이벤트
  // 패턴). 채널이 다른 컴포저가 동시에 받지 않도록 detail.channelId 로 게이트한다.
  useEffect(() => {
    const onAddFiles = (e: Event): void => {
      const detail = (e as CustomEvent<{ channelId: string; files: File[] }>).detail;
      if (!detail || detail.channelId !== channelId) return;
      void onFiles(detail.files);
    };
    window.addEventListener('qufox.composer.addFiles', onAddFiles);
    return () => window.removeEventListener('qufox.composer.addFiles', onAddFiles);
    // onFiles 는 매 렌더 새로 만들어지지만 channelId 동안 동작이 동일하다.
  }, [channelId]);

  // task-021-R1 reviewer HIGH fix / S32 (FR-RT-08): when the user switches
  // channels (or unmounts the composer entirely), send typing:stop for the
  // channel the composer was mounted on so observers don't see a stale
  // indicator until the server ZSET TTL. The previous channel's emitter sends
  // its final stop + tears down its idle timer; a fresh emitter is armed for
  // the new channel so start/stop target the correct channelId.
  useEffect(() => {
    const emitter = makeTypingEmitter(channelId);
    typingEmitterRef.current = emitter;
    return () => {
      // 채널 전환/언마운트 시 즉시 stop(콜론 이벤트) + 타이머 정리.
      emitter.stop();
    };
  }, [channelId]);

  // Auto-grow textarea: reset to 0 to re-measure scrollHeight after
  // every change. Clamp between MIN and MAX; beyond MAX the textarea
  // keeps its max height and scrolls internally.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = '0px';
    const next = Math.min(MAX_HEIGHT_PX, Math.max(MIN_HEIGHT_PX, el.scrollHeight));
    el.style.height = `${next}px`;
  }, [draft]);

  // S32 (FR-RT-08): 입력 발생. 첫 입력 시 typing:start(3초 스로틀) + 10초 idle
  // 타이머 재arm. idle 만료 시 emitter 가 자동으로 typing:stop 을 emit 합니다.
  const maybePing = (): void => {
    typingEmitterRef.current?.onInput();
  };

  // S32 (FR-RT-08): 메시지 전송 / draft 비움 시 즉시 typing:stop + idle 타이머 정리.
  const sendTypingStop = (): void => {
    typingEmitterRef.current?.stop();
  };

  // S02 (FR-MSG-03 / FR-RC17): 실시간 글자수 카운터 상태. 4,000자 초과 시
  // 전송 차단 + danger 색상.
  const counter = computeCounter(draft);

  // ───── S18 (FR-RC03/04/05/06 · FR-MSG-14/15): 컴포저 자동완성 ─────
  // 데이터 소스: 워크스페이스 멤버/채널/온라인 presence/커스텀 이모지/역할.
  // 서버 검색 엔드포인트는 신설하지 않고 기존 목록 query 를 클라에서 필터한다.
  const { user } = useAuth();
  const { data: membersData } = useMembers(workspaceId ?? undefined);
  const { data: wsData } = useWorkspace(workspaceId ?? undefined);
  const { data: channelData } = useChannelList(workspaceId ?? undefined);
  const { onlineUserIds, dndUserIds } = usePresence(workspaceId ?? undefined);
  // S79 (FR-SC-01): 슬래시 커맨드 목록(빌트인 상수 + 워크스페이스 커스텀 병합). 5분 캐시.
  // workspaceId=null(Global DM)이면 훅이 enabled=false 로 자동 비활성.
  const { data: slashCommandData } = useSlashCommands(workspaceId);
  // S80 (FR-SC-05): EPHEMERAL 슬래시 응답(발신자 전용 인라인 시스템 메시지) 채널별 스토어.
  const ephemeral = useEphemeralMessages(channelId);
  // S81b (FR-SC-07): /giphy 실행이 받은 GIF 프리뷰(발신자 전용·채널별 단일).
  // perf MODERATE (S81b 리뷰): Composer 는 set 액션만 필요하므로 preview 는 구독하지 않는다
  // (종전 useGiphyPreview(channelId) 가 preview 까지 반환해 GIF 로드/Shuffle 마다 Composer
  // 전체가 리렌더됐다). set 은 store 의 안정 참조다.
  const setGiphyPreview = useGiphyPreviewStore((s) => s.set);
  // S81a (FR-SC-08): 클라이언트 전용 슬래시 커맨드가 조작하는 로컬 UI 상태들.
  const setMediaCollapsed = useMediaCollapseStore((s) => s.setCollapsed);
  const openSearchPanel = useUI((s) => s.openSearchPanel);
  const setOpenModal = useUI((s) => s.setOpenModal);
  const { toggle: toggleTheme, resolved: resolvedTheme } = useTheme();
  const navigate = useNavigate();

  const myRole: WorkspaceRole =
    wsData?.myRole ??
    (membersData?.members.find((m) => m.userId === user?.id)?.role as WorkspaceRole | undefined) ??
    'MEMBER';

  const memberCount = membersData?.members.length ?? 0;

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
      // S42 (FR-PK02): 별칭도 후보로 주입한다. name 은 매칭/표시용 별칭, insertName 은
      // 선택 시 삽입할 카노니컬 `:name:`(원본 이모지 이름).
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

  const acSlashCommands = useMemo(() => slashCommandData ?? [], [slashCommandData]);

  const acSources = useMemo<AutocompleteSources>(
    () => ({
      members: acMembers,
      channels: acChannels,
      customEmojis: acCustomEmojis,
      // S79 (FR-SC-01): 슬래시 커맨드 후보 주입(빌트인 + 커스텀 병합 GET 결과).
      slashCommands: acSlashCommands,
      online: acOnline,
      // 최근 대화상대/이모지 가중치는 후속 데이터 소스 도입 시 채운다(DEFER).
      recentMembers: [],
      recentEmojis: [],
      role: myRole,
    }),
    [acMembers, acChannels, acCustomEmojis, acSlashCommands, acOnline, myRole],
  );

  const [caret, setCaret] = useState(0);
  // S79 (FR-SC-03 · Fork A = Option 1): 슬래시 커맨드 선택 직후 파라미터 힌트를
  // textarea placeholder 로 일시 교체한다(DS 무변경·단순). null 이면 기본 placeholder.
  // draft 가 비워지거나 채널 전환 시 초기화한다(아래 effect).
  const [paramHint, setParamHint] = useState<string | null>(null);
  // 채널 전환 시 caret 을 새 draft 끝으로 동기화해 이전 채널의 트리거가
  // 잔류하지 않게 한다. draft 길이는 ref 로 읽어 매 키 입력마다 caret 이
  // 끝으로 튀지 않게 한다(채널 전환 시에만 적용).
  const draftLenRef = useRef(draft.length);
  draftLenRef.current = draft.length;
  useEffect(() => {
    setCaret(draftLenRef.current);
  }, [channelId]);
  // S79 (FR-SC-03 · Fork A): draft 가 완전히 비워지거나 채널이 바뀌면 파라미터 힌트
  // placeholder 를 기본으로 되돌린다(전송/clearDraft 후 다음 메시지에 잔류 방지).
  useEffect(() => {
    if (draft.length === 0) setParamHint(null);
  }, [draft.length]);
  useEffect(() => {
    setParamHint(null);
  }, [channelId]);
  const {
    state: acState,
    move: acMove,
    setActiveIndex: acSetActive,
    activeRow: acActiveRow,
    close: acClose,
    emptyTriggerKind: acEmptyKind,
  } = useAutocomplete({
    text: draft,
    caret,
    sources: acSources,
    // Global DM(workspaceId=null)은 멘션/채널 네임스페이스가 없어 끈다.
    enabled: workspaceId !== null,
  });

  const listboxId = useId();
  const optionId = (index: number): string => `${listboxId}-opt-${index}`;
  // S78 reviewer (a11y MEDIUM): 이모지 버튼 aria-controls 가 가리킬 패널 id.
  const emojiPickerId = useId();
  const acMaxHeight = useAutocompleteMaxHeight(acState.open);

  // S78 (FR-A11Y-01): 자동완성 팝업의 등장/결과 수를 공유 라이브 영역
  // (`qf-a11y-announcer`)에 통지한다. 종전엔 컴포저 내부 sr-only div 에 직접
  // 바인딩했으나, 모든 자동완성(@멘션·#채널·:이모지·향후 슬래시/검색)이 동일
  // 리전을 공유하도록 announce() 헬퍼 경유로 전환한다. 팝업이 닫히면 200ms 뒤
  // 빈 문자열로 초기화해 이전 공지의 재낭독을 막는다(race-safe: 연속 팝업 시
  // 헬퍼가 pending 초기화 타이머를 취소하고 새 텍스트를 주입). open 상태와 결과
  // 수가 바뀔 때만 재공지하도록 의존성을 좁힌다. acState 는 판별 유니온이라
  // open=false 면 kind/rows 가 없으므로, 효과로 넘길 스칼라를 미리 추린다.
  //
  // S78 reviewer FF3 (a11y): 팝업은 rows>0 일 때만 열리므로, "트리거 활성·결과
  // 0건"은 acState.open=false 라 위 경로로는 공지되지 않았다(empty-result 분기
  // 도달 불가). acEmptyKind(훅이 노출) 가 있으면 팝업이 닫혀 있어도
  // composerAnnouncement(kind, 0) → "<종류> 검색 결과가 없습니다"(S79 N-01: 종류별)
  // 를 공지해 SR 사용자에게 결과 없음을 전달한다.
  const acOpen = acState.open;
  const acMessage = acState.open
    ? composerAnnouncement(acState.kind, acState.rows.length)
    : acEmptyKind
      ? composerAnnouncement(acEmptyKind, 0)
      : '';
  // FF4 (a11y MAJOR): 언마운트/채널 전환 시 cleanup 으로 announcer 잔류를
  // 제거한다. 공유 싱글턴이라 이 컴포저가 사라져도 이전 공지가 남아 다른
  // 화면에서 재낭독될 수 있으므로, 즉시(resetDelayMs:0) 비운다.
  useEffect(() => {
    if (acMessage) {
      announce(acMessage);
    } else {
      announce('', { resetDelayMs: 200 });
    }
    return () => {
      announce('', { resetDelayMs: 0 });
    };
  }, [acOpen, acMessage]);

  // S79 fix-forward (a11y B-02): 슬래시 커맨드 선택 시 파라미터 usage hint 는
  // placeholder 로만 노출돼 SR 에 전달되지 않았다(입력 중 placeholder 는 재낭독
  // 안 됨). paramHint 가 새로 설정되면 공유 announcer 로 "파라미터 힌트: …" 를
  // 명시 공지한다. 이 효과는 위 자동완성 공지 효과보다 뒤에 등록돼, 행 선택 직후
  // 같은 commit 에서 acClose 로 acMessage='' → announce('') 가 먼저 돈 뒤 이 효과가
  // 힌트를 주입하므로(announce 헬퍼가 pending writeTimer 를 취소·재설정), 자동완성
  // 빈 공지에 clobber 되지 않고 힌트가 최종 낭독된다. paramHint=null(초기/리셋)이면
  // 공지하지 않는다. */
  useEffect(() => {
    if (paramHint) announce(`파라미터 힌트: ${paramHint}`);
  }, [paramHint]);

  // 선택된 행을 컴포저에 삽입하고 트리거 범위를 토큰으로 치환한다.
  //
  // S18 리뷰 BLOCKER: acState.trigger 는 debounce(150ms) 스냅샷 기준 offset 이라
  // 빠르게 타이핑한 뒤 debounce 가 끝나기 전에 Enter/클릭으로 삽입하면 stale
  // offset 으로 live draft 를 치환해 텍스트가 깨졌다. 삽입 직전에 live draft/
  // caret 으로 detectTrigger 를 동기 재실행해 치환 범위를 다시 구한다. 더 이상
  // 트리거가 매치하지 않으면(이미 닫힌 토큰 등) 아무 것도 하지 않고 bail.
  const applyAutocompleteRow = (row: AutocompleteRow): void => {
    if (!acState.open) return;
    const el = textareaRef.current;
    const liveCaret = el?.selectionStart ?? caret;
    const liveTrigger = detectTrigger(draft, liveCaret);
    if (!liveTrigger) {
      acClose();
      return;
    }
    const token = tokenForRow(row);
    const { text, caretPos } = applyToken(draft, liveTrigger.start, liveTrigger.end, token);
    setDraft(channelId, text);
    // S79 (FR-SC-03 · Fork A): 슬래시 커맨드 선택 시 파라미터 힌트를 placeholder 로
    // 일시 교체해 사용자가 무엇을 입력할지 안내한다(실행은 S80). 슬래시가 아니면 null.
    const hint = paramHintForRow(row);
    if (hint) setParamHint(hint);
    acClose();
    queueMicrotask(() => {
      const node = textareaRef.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(caretPos, caretPos);
      setCaret(caretPos);
    });
  };

  // FR-MSG-14: @everyone/@channel/@here confirm dialog 상태.
  const [pendingSpecial, setPendingSpecial] = useState<SpecialMentionKey | null>(null);

  // 현재 draft 에서 confirm 이 필요한 특수멘션(권한 보유분)을 찾는다.
  // 게이트는 서버(gateEveryoneMention / gateHereMention)와 동일 역할 로직을
  // canUseSpecialMention 으로 공유한다 — 권한 없으면 서버가 fanout 을 무효화
  // (FR-MSG-15)하므로 confirm 도 띄우지 않는다. `@channel` 은 서버 extractor 가
  // 추출하지 않아 알림이 안 가므로 confirm 세트에서 제외한다(거짓 약속 방지).
  const findSpecialNeedingConfirm = (text: string): SpecialMentionKey | null => {
    const lower = text.toLowerCase();
    const keys: SpecialMentionKey[] = ['everyone', 'here'];
    for (const key of keys) {
      const re = new RegExp(`(?<![A-Za-z0-9_])@${key}(?![A-Za-z0-9_])`);
      if (!re.test(lower)) continue;
      // 권한 없으면 서버가 fanout 을 무효화(FR-MSG-15) — confirm 불필요.
      if (!canUseSpecialMention(key, myRole)) continue;
      if (needsSpecialMentionConfirm(key, memberCount)) return key;
    }
    return null;
  };

  const doSend = (): void => {
    const trimmed = draft.trim();
    const hasAttachments = trayItems.length > 0;
    if (!trimmed && !hasAttachments) return;
    // 업로드 진행 중이거나 전송 중이면 막는다(전송 버튼도 비활성 — 이중 가드).
    if (uploading > 0 || sending) return;
    // S56 fix-forward (MAJOR-1 — 데이터 손실): 실패한 첨부가 남아 있으면 전송을
    // 차단한다. 종전엔 READY 만 전송하고 트레이를 전부 비워(reset) 사용자가 모르게
    // 실패 첨부가 유실됐다. 사용자가 실패 항목을 제거하거나 재시도하도록 안내한다
    // (completeAndCollect 도 failed 를 보존하지만, 전송 게이트가 1차 방어선).
    if (failedAttachments > 0) {
      notify({
        variant: 'warning',
        title: '업로드 실패한 첨부가 있습니다',
        body: '실패한 첨부를 제거하거나 다시 시도해 주세요.',
        ttlMs: 6000,
      });
      return;
    }

    if (!hasAttachments) {
      // 첨부 없는 일반 전송 — 동기.
      send(trimmed || ' ');
      clearDraft(channelId);
      setPendingSpecial(null);
      sendTypingStop();
      return;
    }

    // S56/S57 (D11 / FR-AM-24): READY 항목을 sending 으로 낙관 전환 후
    // complete(지수 백오프) → attachmentIds 모은 뒤 sendMessage. 성공 항목은
    // confirmed 로 남아 있으므로 전송 직후 clearConfirmed 로 트레이에서 비운다.
    setSending(true);
    void tray
      .completeAndCollect()
      .then((attachmentIds) => {
        // complete 가 실패하면(빈 배열) 토스트는 훅이 이미 띄웠고, 본문만으로
        // 전송할지 사용자가 다시 시도할 수 있게 draft 는 유지한다(failed 항목 보존).
        if (attachmentIds.length === 0) return;
        send(trimmed || ' ', attachmentIds);
        tray.clearConfirmed();
        clearDraft(channelId);
        setPendingSpecial(null);
        sendTypingStop();
      })
      .finally(() => setSending(false));
  };

  // S80 (FR-SC-04·05·06): draft 가 실행 가능한 슬래시 커맨드면 doSend 대신 execute 한다.
  // IN_CHANNEL(메시지 생성) → draft 클리어(WS message:created 가 자동 표시), EPHEMERAL →
  // 인라인 시스템 메시지 표시, error → draft 유지(사용자가 고쳐 재시도). detect 가 null 이면
  // 일반 전송으로 폴백한다. workspaceId=null(Global DM)은 슬래시 실행 비활성(폴백).
  const runSlashExecution = (command: string, text: string): void => {
    if (workspaceId === null) {
      doSend();
      return;
    }
    const idempotencyKey = crypto.randomUUID();
    setSending(true);
    void executeSlashCommand({ workspaceId, channelId, command, text, idempotencyKey })
      .then((res) => {
        if (res.responseType === 'IN_CHANNEL') {
          // 채널 게시 성공 — draft 비움(message:created WS 가 메시지를 표시).
          clearDraft(channelId);
          setPendingSpecial(null);
          sendTypingStop();
          return;
        }
        // S81b (FR-SC-07): GIPHY_PREVIEW — 발신자 전용 GIF 프리뷰를 인라인 카드로 띄운다.
        // 채널 미게시(Send 시에만 게시). draft 를 비워 후속 입력을 받게 한다.
        if (res.responseType === 'GIPHY_PREVIEW') {
          setGiphyPreview({
            channelId,
            gifUrl: res.gifUrl,
            gifThumbUrl: res.gifThumbUrl,
            title: res.title,
            keyword: res.keyword,
            offset: res.offset,
          });
          announce(`"${res.keyword}" GIF 미리보기를 열었습니다`);
          clearDraft(channelId);
          setPendingSpecial(null);
          sendTypingStop();
          return;
        }
        // EPHEMERAL — 발신자 전용 인라인 메시지. error 면 draft 유지(고쳐 재시도).
        const isError = res.error === true;
        ephemeral.push(res.content, isError);
        announce(res.content);
        if (!isError) {
          clearDraft(channelId);
          setPendingSpecial(null);
          sendTypingStop();
          // S81a (FR-SC-08): /msg 는 DM 을 열고 navigate 대상을 싣는다 — 그 DM 으로 이동한다.
          if (res.navigate?.kind === 'dm') {
            navigate(`/dm/${res.navigate.userId}`);
          }
        }
      })
      .catch((err: unknown) => {
        const message =
          err && typeof err === 'object' && 'message' in err
            ? String((err as { message: unknown }).message)
            : '슬래시 커맨드 실행에 실패했습니다';
        // 서버 에러도 인라인 ephemeral 로 보여주고 draft 는 유지한다.
        ephemeral.push(message, true);
        announce(message);
      })
      .finally(() => setSending(false));
  };

  // S81a (FR-SC-08): 클라이언트 전용 슬래시 커맨드를 서버 호출 없이 로컬에서 수행한다.
  // collapse/expand → 현재 채널 미디어 접기/펼치기, search → 검색 패널 + 키워드 pre-fill,
  // shortcuts → 단축키 오버레이, darkmode → 테마 토글. 각 액션 후 draft 를 비우고
  // 발신자 전용 EPHEMERAL 확인을 인라인으로 띄운다(서버 미게시).
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
        openSearchPanel(action.query);
        confirmText =
          action.query.length > 0
            ? `"${action.query}" 검색을 열었습니다`
            : '검색 패널을 열었습니다';
        break;
      case 'openShortcuts':
        setOpenModal('shortcut-help');
        confirmText = '단축키 도움말을 열었습니다';
        break;
      case 'toggleTheme':
        // a11y(MAJOR-2): 전환 방향을 확인 메시지에 명시한다(SR 상태 메시지 충분성). toggle 은
        // resolved === 'dark' ? 'light' : 'dark' 이므로 현재값의 반대가 다음 테마다.
        confirmText =
          resolvedTheme === 'dark' ? '라이트 모드로 전환했습니다' : '다크 모드로 전환했습니다';
        toggleTheme();
        break;
    }
    ephemeral.push(confirmText, false);
    announce(confirmText);
    clearDraft(channelId);
    setPendingSpecial(null);
    sendTypingStop();
  };

  const submit = (): void => {
    // 한도 초과 시 전송 차단(FR-MSG-03 — "초과 시 전송 불가").
    if (counter.overLimit) return;
    const trimmed = draft.trim();
    if (!trimmed && trayItems.length === 0) return;
    // S80 (FR-SC-04·05·06): 슬래시 커맨드 실행 분기(첨부 없는 텍스트 전용). 자동완성
    // 팝업이 열려 있으면(키보드 핸들러가 먼저 삽입을 처리) 이 분기는 닫힌 뒤에만 도달한다.
    if (trayItems.length === 0 && uploading === 0) {
      const slash = detectSlashExecution(trimmed, slashCommandData ?? []);
      if (slash) {
        // S81a (FR-SC-08): 클라이언트 전용 커맨드면 서버 호출 없이 로컬 UI 액션을 수행한다.
        const clientAction = detectClientSlashAction(slash.command, slash.text);
        if (clientAction) {
          runClientSlashAction(clientAction);
          return;
        }
        runSlashExecution(slash.command, slash.text);
        return;
      }
    }
    // S44 (FR-MN-16): 권한 없는 @everyone/@here 를 입력하면 전송 전 경고 토스트로
    // "이 채널에서 알림이 가지 않음"을 고지한다. 메시지는 그대로 전송되며(서버
    // 게이트가 fanout 만 silently 무효화 — FR-MN-02 / Discord parity), 사용자는
    // 의도와 결과의 괴리를 알게 된다. 권한 기준은 역할 기본값(canUseSpecialMention)
    // 으로, 클라이언트가 채널 override 까지는 알 수 없어 보수적으로 안내한다.
    const unauthorized = firstUnauthorizedSpecialMention(draft, myRole);
    if (unauthorized) {
      // S44 fix-forward (MINOR · copy 완화): 클라이언트는 역할 기본값만 알고 채널
      // override 는 모른다. override 로 허용된 MEMBER 는 실제로 알림이 *전송되므로*,
      // 단정형("전송되지 않습니다") 대신 불확정형으로 안내해 거짓 약속을 피한다.
      notify({
        variant: 'warning',
        title:
          unauthorized === 'everyone'
            ? '@everyone 권한이 없을 수 있습니다'
            : '@here 권한이 없을 수 있습니다',
        body: '이 채널에서 해당 멘션 알림 권한이 없으면 알림이 가지 않을 수 있습니다.',
        ttlMs: 6000,
      });
    }
    // FR-MSG-14: 대규모 특수멘션이면 먼저 confirm dialog 를 띄운다.
    const special = findSpecialNeedingConfirm(draft);
    if (special) {
      setPendingSpecial(special);
      return;
    }
    doSend();
  };

  const insertAtCursor = (text: string): void => {
    const el = textareaRef.current;
    const cur = draft;
    if (!el) {
      setDraft(channelId, cur + text);
      return;
    }
    const start = el.selectionStart ?? cur.length;
    const end = el.selectionEnd ?? cur.length;
    const next = cur.slice(0, start) + text + cur.slice(end);
    setDraft(channelId, next);
    // Restore caret after the inserted run — schedule for post-render
    // so the textarea's new value is in the DOM.
    queueMicrotask(() => {
      if (!textareaRef.current) return;
      const pos = start + text.length;
      textareaRef.current.focus();
      textareaRef.current.setSelectionRange(pos, pos);
      // S18 리뷰 NIT: caret state 를 삽입 위치로 동기화해 트리거 재평가가
      // stale offset 을 보지 않게 한다(applyAutocompleteRow 와 동일).
      setCaret(pos);
    });
  };

  // S56 (D11 / FR-AM-01): 파일 진입(드롭다운 input / 드롭 / 붙여넣기) 공통 경로.
  // 클램프(최대 10개)는 트레이 항목 수 ref 기준으로 racing 호출을 직렬화한다.
  const onFiles = async (files: FileList | File[] | null): Promise<void> => {
    if (!files) return;
    const incoming = Array.from(files);
    if (incoming.length === 0) return;
    const currentCount = trayCountRef.current;
    const { accepted, rejected, truncated } = clampAttachments({ currentCount, incoming });
    if (truncated) {
      notify({
        variant: 'warning',
        title: '첨부 파일 한도',
        body: `최대 ${MAX_ATTACHMENTS}개까지 첨부할 수 있습니다. ${rejected}개를 무시했습니다.`,
        ttlMs: 4000,
      });
    }
    if (accepted.length === 0) return;
    // racing 드롭/선택 가드: 다음 호출이 즉시 최신 수를 보도록 ref 를 선반영.
    trayCountRef.current = currentCount + accepted.length;
    tray.addFiles(accepted);
  };

  // S13 (FR-CH-19): 게시 권한이 없는 ANNOUNCEMENT 채널이면 입력 자체를
  // 비활성화한다 — disabled textarea + 안내 placeholder + 클릭 시 툴팁.
  if (postingRestricted) {
    return (
      <div className="px-[var(--s-5)] pb-[var(--s-5)] pt-0">
        <Tooltip label="게시 권한이 없습니다" side="top">
          <div
            data-testid="composer-posting-restricted"
            className={cn(
              'flex items-center gap-[var(--s-3)]',
              'rounded-[var(--r-lg)] border border-border-subtle bg-bg-input',
              'px-[var(--s-4)] py-[var(--s-3)] cursor-not-allowed',
            )}
          >
            <Icon name="megaphone" size="md" className="text-text-muted" />
            <textarea
              id="msg-input"
              data-testid="msg-input"
              rows={1}
              disabled
              aria-label="이 채널은 관리자만 게시할 수 있습니다"
              placeholder="이 채널은 관리자만 게시할 수 있습니다"
              className="flex-1 resize-none bg-transparent outline-none placeholder:text-text-muted text-foreground cursor-not-allowed"
              style={{ minHeight: `${MIN_HEIGHT_PX}px` }}
            />
          </div>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className="px-[var(--s-5)] pb-[var(--s-5)] pt-0">
      {/* S56 (D11 / FR-AM-02/22): 전송 전 첨부 미리보기 트레이. 항목별 진행률/
          상태/alt/spoiler/제거/재시도 — AttachmentTray 가 렌더한다. */}
      <AttachmentTray
        items={trayItems}
        onRemove={tray.removeItem}
        onRetry={tray.retryItem}
        onAltChange={tray.setAltText}
        onToggleSpoiler={tray.toggleSpoiler}
      />
      <form
        data-testid="msg-composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="sr-only" htmlFor="msg-input">
          {`# ${channelName} 로 메시지 보내기`}
        </label>
        {/* DS mockup (§ full chat column): rounded --r-lg container with
            --bg-input surface and a + button / input / emoji trigger
            inline. No send button — Enter submits.
            items-center: symmetric top/bottom padding around a
            single-line textarea (items-end dropped the text to the
            bottom while the padding kept the full height). For
            multi-line textareas the 28px buttons center against the
            taller textarea, mirroring Discord / Slack. */}
        <div
          className={cn(
            'relative flex items-center gap-[var(--s-3)]',
            'rounded-[var(--r-lg)] border border-border-subtle bg-bg-input',
            'px-[var(--s-4)] py-[var(--s-3)]',
          )}
        >
          <DropdownRoot>
            <DropdownTrigger asChild>
              <button
                type="button"
                data-testid="composer-plus"
                aria-label="첨부 및 기타 작업"
                className="qf-btn qf-btn--ghost qf-btn--icon qf-btn--sm"
              >
                <Icon name="plus-circle" size="md" />
              </button>
            </DropdownTrigger>
            <DropdownContent align="start" side="top">
              <DropdownItem onSelect={() => fileInputRef.current?.click()}>
                <span
                  data-testid="composer-attach-file"
                  className="inline-flex items-center gap-[var(--s-2)]"
                >
                  <Icon name="attach" size="sm" />
                  파일 업로드
                </span>
              </DropdownItem>
              {/* Placeholder for future extensions (voice memo, poll,
                  slash commands…). Keeping the dropdown here means the
                  later additions just append items. */}
              <DropdownItem disabled>
                <span className="inline-flex items-center gap-[var(--s-2)] text-text-muted">
                  <Icon name="mic" size="sm" />
                  음성 메모 — 곧 지원
                </span>
              </DropdownItem>
            </DropdownContent>
          </DropdownRoot>
          {/* S56 fix-forward (a11y M-04): `hidden` 은 input 을 접근성 트리에서도
              제거해 aria-label 이 무효였다. sr-only 로 바꿔 시각적으로는 숨기되
              접근성 트리에는 남기고(파일 다이얼로그는 + 버튼이 click 으로 트리거),
              tabIndex={-1} 로 탭 순서에서는 제외한다. */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="sr-only"
            tabIndex={-1}
            aria-label="파일 첨부"
            data-testid="composer-file-input"
            onChange={(e) => {
              void onFiles(e.target.files);
              // Reset so the same file can be picked twice in a row.
              e.target.value = '';
            }}
          />
          <textarea
            id="msg-input"
            ref={textareaRef}
            data-testid="msg-input"
            value={draft}
            rows={1}
            // S18 (FR-RC06): WAI-ARIA Combobox(activedescendant 패턴). 포커스는
            // textarea 에 유지하고 active 항목만 aria-activedescendant 로 가리킨다.
            role="combobox"
            // A-02: 팝업 종류가 listbox 임을 항상 노출.
            aria-haspopup="listbox"
            aria-expanded={acState.open}
            aria-autocomplete="list"
            // A-01: aria-controls 는 팝업 닫힘에도 제거하지 않고 항상 listboxId 를
            // 가리킨다(일부 SR 은 닫힘→열림 전환 시 controls 재해석을 놓친다).
            aria-controls={listboxId}
            aria-activedescendant={
              acState.open && acState.activeIndex >= 0 ? optionId(acState.activeIndex) : undefined
            }
            onChange={(e) => {
              const next = e.target.value;
              setDraft(channelId, next);
              setCaret(e.target.selectionStart ?? next.length);
              if (next.length > 0) maybePing();
              else sendTypingStop();
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            onClick={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            onKeyUp={(e) => {
              // 방향키/Home/End 등으로 캐럿이 움직이면 트리거 재평가를 위해
              // caret 을 동기화한다(삽입/제출 키는 keyDown 에서 이미 처리).
              if (
                e.key === 'ArrowLeft' ||
                e.key === 'ArrowRight' ||
                e.key === 'Home' ||
                e.key === 'End'
              ) {
                setCaret(e.currentTarget.selectionStart ?? 0);
              }
            }}
            onKeyDown={(e) => {
              // task-021-R1-ime-enter-half-sends: skip Enter when an IME
              // composition is in flight. `nativeEvent.isComposing` is
              // the standard signal; `keyCode === 229` covers older
              // browsers / Korean IMEs that dispatch the pseudo-key
              // before composition end.
              const native = e.nativeEvent as KeyboardEvent & { isComposing?: boolean };
              if (native.isComposing || e.keyCode === 229) return;
              // S18 (FR-RC06): 자동완성 팝업이 열려 있으면 ↑↓ 이동,
              // Enter/Tab 삽입, Esc 닫기를 컴포저 제출보다 먼저 처리한다.
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
                if (e.key === 'Enter' || e.key === 'Tab') {
                  if (acActiveRow) {
                    // 활성 행이 있으면 삽입 + 닫기(applyAutocompleteRow 가 close).
                    e.preventDefault();
                    applyAutocompleteRow(acActiveRow);
                    return;
                  }
                  // A-10: 활성 행이 없는데 팝업만 떠 있으면 Tab 이 팝업을
                  // 잔류시킨 채 통과한다. Tab 은 팝업을 닫고 기본 포커스
                  // 이동을 허용한다(preventDefault 안 함). Enter 는 아래
                  // 제출 분기로 흘려보낸다.
                  if (e.key === 'Tab') {
                    acClose();
                    return;
                  }
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  acClose();
                  return;
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            aria-invalid={counter.overLimit || undefined}
            // S79 (FR-SC-03 · Fork A): 슬래시 커맨드 선택 직후엔 파라미터 usage hint 를
            // placeholder 로 노출하고, 그 외엔 기본 채널 placeholder 를 쓴다.
            placeholder={paramHint ?? `# ${channelName} 에 메시지…`}
            className="flex-1 resize-none bg-transparent outline-none placeholder:text-text-muted text-foreground"
            style={{ minHeight: `${MIN_HEIGHT_PX}px`, maxHeight: `${MAX_HEIGHT_PX}px` }}
          />
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
          {/* S78 (FR-A11Y-01): 자동완성 등장/결과 수 통지는 공유 라이브 영역
              (`qf-a11y-announcer`)으로 위임한다(announce() 헬퍼·위 useEffect).
              컴포저 내부 sr-only div 는 제거했다. */}
          <button
            type="button"
            data-testid="composer-emoji"
            aria-label="이모티콘 삽입"
            // S78 reviewer (a11y MEDIUM): 팝업 종류(dialog)와 제어 대상 패널을
            // 노출해 SR 사용자가 버튼이 어떤 오버레이를 여는지 알 수 있게 한다.
            aria-haspopup="dialog"
            aria-controls={emojiPickerId}
            aria-expanded={emojiOpen}
            onClick={() => setEmojiOpen((v) => !v)}
            className="qf-btn qf-btn--ghost qf-btn--icon qf-btn--sm self-end"
          >
            <Icon name="emoji" size="md" />
          </button>
          {emojiOpen ? (
            <EmojiPicker
              id={emojiPickerId}
              className="absolute bottom-full right-0 mb-[var(--s-2)]"
              onSelect={(emoji) => {
                insertAtCursor(emoji);
                // Keep the picker open so the user can pick multiple —
                // matches Slack/Discord composer behaviour. Dismiss via
                // outside click or Escape (handled inside EmojiPicker).
              }}
              onDismiss={() => setEmojiOpen(false)}
              customEmojis={customEmojiData?.items.map((ce) => ({
                id: ce.id,
                name: ce.name,
                url: ce.url,
              }))}
            />
          ) : null}
        </div>
        {/* S02 (FR-MSG-03 / FR-RC17): 실시간 글자수 카운터. 경고 구간부터
            노출, 초과 시 danger 색상. 색상은 DS 토큰 alias 만 사용. */}
        {counter.shouldShow ? (
          <div
            data-testid="composer-char-counter"
            data-over-limit={counter.overLimit ? 'true' : 'false'}
            aria-live="polite"
            className={cn(
              'mt-[var(--s-1)] text-right text-[length:var(--fs-11)]',
              counter.overLimit ? 'text-danger' : 'text-text-muted',
            )}
          >
            {counter.remaining}
          </div>
        ) : null}
        {counter.overLimit ? (
          <p
            data-testid="composer-too-long-warning"
            role="alert"
            className="mt-[var(--s-1)] text-right text-[length:var(--fs-11)] text-danger"
          >
            메시지가 너무 깁니다. 4,000자 이하로 줄여 주세요.
          </p>
        ) : null}
        {/* Hidden submit so the form's onSubmit fires on Enter. No
            visible send button per the DS composer sample. */}
        <button
          type="submit"
          hidden
          aria-hidden="true"
          data-testid="msg-send"
          disabled={
            mutation.isPending ||
            uploading > 0 ||
            // MAJOR-1: 실패한 첨부가 있으면 전송 비활성(사용자가 제거/재시도해야 함).
            failedAttachments > 0 ||
            sending ||
            counter.overLimit ||
            (draft.trim().length === 0 && trayItems.length === 0)
          }
        />
      </form>
      {/* S18 (FR-MSG-14): 대규모 특수멘션 전송 전 확인 dialog. 수신자 수는
          정확한 채널 멤버 수 소스가 없어 dialog 가 범위만 완곡히 안내한다. */}
      <SpecialMentionConfirmDialog
        open={pendingSpecial !== null}
        mentionKey={pendingSpecial}
        onConfirm={doSend}
        onCancel={() => setPendingSpecial(null)}
      />
    </div>
  );
}
