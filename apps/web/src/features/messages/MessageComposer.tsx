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
import { uploadAttachment, type UploadedAttachment } from './useAttachmentUpload';
import { clampAttachments, MAX_ATTACHMENTS } from './clampAttachments';
import { computeCounter } from './composerCounter';
import { cn } from '../../lib/cn';
import { Autocomplete } from './autocomplete/Autocomplete';
import { SpecialMentionConfirmDialog } from './autocomplete/SpecialMentionConfirmDialog';
import {
  useAutocomplete,
  type AutocompleteRow,
  type AutocompleteSources,
} from './autocomplete/useAutocomplete';
import { insertToken } from './autocomplete/insertToken';
import { detectTrigger, type TriggerKind } from './autocomplete/detectTrigger';
import { useAutocompleteMaxHeight } from './autocomplete/popupMaxHeight';
import {
  canUseSpecialMention,
  needsSpecialMentionConfirm,
  type SpecialMentionKey,
  type WorkspaceRole,
} from './autocomplete/specialMention';
import type { RankableMember } from './autocomplete/rankMembers';
import type { RankableChannel } from './autocomplete/filterChannels';
import type { EmojiCandidate } from './autocomplete/filterEmojis';

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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// A-03: 자동완성 종류별 sr-only 통지 명사. "멤버 3개" 처럼 결과 수와 결합한다.
const AC_SECTION_NOUN: Record<TriggerKind, string> = {
  mention: '멤버',
  channel: '채널',
  emoji: '이모지',
};

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
  return row.emoji.kind === 'unicode' ? row.emoji.glyph : `:${row.emoji.name}:`;
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
  // Uploaded-but-not-yet-sent attachments. Flushed after submit.
  const [pending, setPending] = useState<UploadedAttachment[]>([]);
  // In-flight / failed upload jobs. `pending` holds the finalized rows
  // only (attachmentId the server knows about); `jobs` holds the
  // lifecycle state so the chip UI can show "업로드 중…" and
  // "업로드 실패 · 재시도" with a retry button. Cleared after send.
  const [jobs, setJobs] = useState<
    Array<{
      id: string;
      file: File;
      status: 'uploading' | 'failed';
      error?: string;
    }>
  >([]);
  // task-042 R0 F3 (review M2 follow): refs mirror pending/jobs so
  // `onFiles` reading mid-async never sees stale closure values. The
  // race the reviewer flagged is "user picks files via dropdown then
  // immediately drops more files before React re-renders" — both
  // closures read the same `pending.length + jobs.length` snapshot,
  // both pass the cap check, sum exceeds 10. Refs are updated on
  // every state change (synchronous via useEffect → not perfect but
  // covers the typical 100ms double-pick window) so the clamp reads
  // the latest count.
  const pendingRef = useRef(pending);
  const jobsRef = useRef(jobs);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);
  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);
  const uploading = jobs.filter((j) => j.status === 'uploading').length;

  useEffect(() => {
    textareaRef.current?.focus();
    setPending([]);
    setJobs([]);
    setEmojiOpen(false);
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

  const acCustomEmojis = useMemo<EmojiCandidate[]>(
    () =>
      (customEmojiData?.items ?? []).map(
        (ce): EmojiCandidate => ({ kind: 'custom', name: ce.name, url: ce.url }),
      ),
    [customEmojiData],
  );

  const acOnline = useMemo(
    () => new Set<string>([...onlineUserIds, ...dndUserIds]),
    [onlineUserIds, dndUserIds],
  );

  const acSources = useMemo<AutocompleteSources>(
    () => ({
      members: acMembers,
      channels: acChannels,
      customEmojis: acCustomEmojis,
      online: acOnline,
      // 최근 대화상대/이모지 가중치는 후속 데이터 소스 도입 시 채운다(DEFER).
      recentMembers: [],
      recentEmojis: [],
      role: myRole,
    }),
    [acMembers, acChannels, acCustomEmojis, acOnline, myRole],
  );

  const [caret, setCaret] = useState(0);
  // 채널 전환 시 caret 을 새 draft 끝으로 동기화해 이전 채널의 트리거가
  // 잔류하지 않게 한다. draft 길이는 ref 로 읽어 매 키 입력마다 caret 이
  // 끝으로 튀지 않게 한다(채널 전환 시에만 적용).
  const draftLenRef = useRef(draft.length);
  draftLenRef.current = draft.length;
  useEffect(() => {
    setCaret(draftLenRef.current);
  }, [channelId]);
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

  // A-03: 팝업 등장/결과 수를 sr-only aria-live 로 통지한다. 닫히면 빈
  // 문자열로 되돌려(무음) 다음 open 전환에서 다시 읽히게 한다. live region
  // 노드는 항상 마운트해 둬야 SR 이 텍스트 변경을 감지한다.
  const acAnnouncement = acState.open
    ? `${AC_SECTION_NOUN[acState.kind]} ${acState.rows.length}개`
    : '';

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
    if (!trimmed && pending.length === 0) return;
    send(trimmed || ' ', pending.length > 0 ? pending.map((p) => p.id) : undefined);
    clearDraft(channelId);
    setPending([]);
    setPendingSpecial(null);
    sendTypingStop();
  };

  const submit = (): void => {
    // 한도 초과 시 전송 차단(FR-MSG-03 — "초과 시 전송 불가").
    if (counter.overLimit) return;
    const trimmed = draft.trim();
    if (!trimmed && pending.length === 0) return;
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

  const runUpload = async (jobId: string, file: File): Promise<void> => {
    try {
      const uploaded = await uploadAttachment(channelId, file);
      setPending((p) => [...p, uploaded]);
      setJobs((prev) => prev.filter((j) => j.id !== jobId));
    } catch (err) {
      const msg = (err as Error).message;
      setJobs((prev) =>
        prev.map((j) => (j.id === jobId ? { ...j, status: 'failed', error: msg } : j)),
      );
      notify({
        variant: 'danger',
        title: '업로드 실패',
        body: `${file.name}: ${msg}`,
      });
    }
  };

  const onFiles = async (files: FileList | null): Promise<void> => {
    if (!files || files.length === 0) return;
    // task-040 R4 + task-042 R0 F3 (review M2): clamp via refs so two
    // racing onFiles calls each see the latest pending+jobs state.
    // Without refs both calls read the same render-snapshot count and
    // could collectively exceed MAX_ATTACHMENTS. The refs are updated
    // synchronously by the useEffect mirror above; even back-to-back
    // calls in the same tick now serialize via reading pendingRef +
    // jobsRef before deciding the slice.
    const incoming = Array.from(files);
    const currentCount = pendingRef.current.length + jobsRef.current.length;
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
    const newJobs = accepted.map((file) => ({
      id: crypto.randomUUID(),
      file,
      status: 'uploading' as const,
    }));
    // Functional updater so the append is correct even if React
    // batches the state update. Ref mirror above guarantees the next
    // racing onFiles call sees these jobs in its currentCount.
    setJobs((prev) => {
      const next = [...prev, ...newJobs];
      jobsRef.current = next;
      return next;
    });
    await Promise.all(newJobs.map((job) => runUpload(job.id, job.file)));
  };

  const retryJob = (jobId: string): void => {
    const job = jobs.find((j) => j.id === jobId);
    if (!job) return;
    setJobs((prev) =>
      prev.map((j) => (j.id === jobId ? { ...j, status: 'uploading', error: undefined } : j)),
    );
    void runUpload(jobId, job.file);
  };

  const removeJob = (jobId: string): void => {
    setJobs((prev) => prev.filter((j) => j.id !== jobId));
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
              className="flex-1 resize-none bg-transparent outline-none placeholder:text-text-muted text-text cursor-not-allowed"
              style={{ minHeight: `${MIN_HEIGHT_PX}px` }}
            />
          </div>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className="px-[var(--s-5)] pb-[var(--s-5)] pt-0">
      {/* Pending attachments: chips above the composer so the user sees
          what'll go out with the next send. Removable before submit. */}
      {pending.length > 0 || jobs.length > 0 ? (
        <ul
          data-testid="composer-pending-attachments"
          className="mb-[var(--s-2)] flex flex-wrap gap-[var(--s-2)]"
        >
          {pending.map((a) => (
            <li
              key={a.id}
              data-testid={`composer-attachment-${a.id}`}
              className="flex items-center gap-[var(--s-2)] rounded-[var(--r-md)] border border-border-subtle bg-bg-elevated px-[var(--s-3)] py-[var(--s-2)] text-[length:var(--fs-13)]"
            >
              <span className="truncate">{a.originalName}</span>
              <span className="text-text-muted">{formatSize(a.sizeBytes)}</span>
              <button
                type="button"
                aria-label={`${a.originalName} 첨부 제거`}
                onClick={() => setPending((p) => p.filter((x) => x.id !== a.id))}
                className="text-text-muted hover:text-text-strong"
              >
                <Icon name="x" size="sm" />
              </button>
            </li>
          ))}
          {jobs.map((j) => (
            <li
              key={j.id}
              data-testid={`composer-upload-job-${j.id}`}
              data-status={j.status}
              className={cn(
                'flex items-center gap-[var(--s-2)] rounded-[var(--r-md)] border px-[var(--s-3)] py-[var(--s-2)] text-[length:var(--fs-13)]',
                j.status === 'failed'
                  ? 'border-danger/60 bg-danger/10 text-danger'
                  : 'border-border-subtle bg-bg-elevated text-text-muted',
              )}
            >
              <span className="truncate">{j.file.name}</span>
              <span className="text-text-muted">{formatSize(j.file.size)}</span>
              {j.status === 'uploading' ? (
                <span className="text-text-muted">업로드 중…</span>
              ) : (
                <>
                  <span className="truncate">실패</span>
                  <button
                    type="button"
                    data-testid={`composer-upload-retry-${j.id}`}
                    aria-label={`${j.file.name} 업로드 재시도`}
                    onClick={() => retryJob(j.id)}
                    className="qf-btn qf-btn--ghost qf-btn--sm !h-auto !px-[var(--s-2)] !py-0 text-accent"
                  >
                    재시도
                  </button>
                </>
              )}
              <button
                type="button"
                data-testid={`composer-upload-remove-${j.id}`}
                aria-label={`${j.file.name} 업로드 제거`}
                onClick={() => removeJob(j.id)}
                className="text-text-muted hover:text-text-strong"
              >
                <Icon name="x" size="sm" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
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
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
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
            placeholder={`# ${channelName} 에 메시지…`}
            className="flex-1 resize-none bg-transparent outline-none placeholder:text-text-muted text-text"
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
          {/* A-03: 자동완성 팝업 등장/결과 수 통지. 항상 마운트(무음 시 빈
              텍스트)해 SR 이 open 전환의 텍스트 변경을 감지하게 한다. */}
          <span
            className="sr-only"
            role="status"
            aria-live="polite"
            data-testid="autocomplete-live"
          >
            {acAnnouncement}
          </span>
          <button
            type="button"
            data-testid="composer-emoji"
            aria-label="이모티콘 삽입"
            aria-expanded={emojiOpen}
            onClick={() => setEmojiOpen((v) => !v)}
            className="qf-btn qf-btn--ghost qf-btn--icon qf-btn--sm self-end"
          >
            <Icon name="emoji" size="md" />
          </button>
          {emojiOpen ? (
            <EmojiPicker
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
            counter.overLimit ||
            (draft.trim().length === 0 && pending.length === 0)
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
