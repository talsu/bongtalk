import { useEffect, useRef, useState } from 'react';
import type { MessageDto, WorkspaceRole } from '@qufox/shared-types';
import { cn } from '../../lib/cn';
import {
  Avatar,
  DropdownRoot,
  DropdownTrigger,
  DropdownContent,
  DropdownItem,
  DropdownSeparator,
  Icon,
} from '../../design-system/primitives';
import { useNotifications } from '../../stores/notification-store';
import { useClock24h } from '../../stores/appearance-store';
import { ReactionBar } from '../reactions/ReactionBar';
import { ReactionUsersModal } from '../reactions/ReactionUsersModal';
import { useCustomEmojiLookup } from '../emojis/CustomEmojiContext';
import { roleBadgeLabel } from './roleBadge';
import { renderMessageContent, extractMessageUrls } from './parseContent';
import { renderAst, type MentionLookup } from './renderAst';
import { resolveCopyPlainText } from './copyText';
import { EditHistoryPopover } from './EditHistoryPopover';
import { AttachmentsList } from '../attachments/AttachmentsList';
import type { AttachmentLite } from '@qufox/shared-types';
import { LinkPreview } from './LinkPreview';
import { formatMessageTime, formatMessageTimeISO, formatClockPart } from './formatMessageTime';
import { isJumboEmoji } from './jumboEmoji';
import { canStartThread, threadChipVisible as computeThreadChipVisible } from './threadActionGate';
// S75 (FR-PS-07): 작성자 아바타/이름 → 프로필 팝오버 트리거(워크스페이스 채널 한정).
import { ProfilePopover } from '../profile/ProfilePopover';

type Props = {
  msg: MessageDto;
  isMine: boolean;
  /**
   * S37 (FR-MSG-08): 편집 이력 팝오버가 워크스페이스 스코프 history 엔드포인트를
   * 호출하기 위한 wsId. DM(null)이면 팝오버가 fetch 를 비활성하고 (수정됨) 라벨만
   * 정적으로 표시합니다.
   */
  workspaceId?: string | null;
  /**
   * True when the previous message is from the same author within the
   * grouping window (see MessageList). Collapses avatar + meta to
   * produce Discord-like read flow.
   */
  isContinuation?: boolean;
  authorName?: string;
  authorRole?: WorkspaceRole | null;
  /**
   * S04 (FR-MSG-13): userId→handle 해석 룩업. 서버가 `@username` 을
   * `@{cuid2}` 로 정규화해 저장하므로 contentAst 의 mention_user 노드는
   * userId 만 담습니다. 이 룩업으로 다시 표시명 pill 을 그립니다. 미전달
   * 시 userId 폴백.
   */
  mentions?: MentionLookup;
  /**
   * task-045 iter1: viewer (현재 로그인 사용자) 의 워크스페이스 role.
   * `OWNER` / `ADMIN` 만 Pin/Unpin 메뉴 노출. DM 채널은 wsId 가 없어
   * pin 미지원이므로 부모가 `null` 전달 시 Pin/Unpin 자동 hide.
   */
  viewerRole?: WorkspaceRole | null;
  /**
   * S51 (FR-PS-05): 채널 핀 권한 토글. false 면 MEMBER 의 핀/해제 메뉴를 숨긴다
   * (서버 게이트와 정합). 기본 true(미전달 시 멤버 허용 — S50 동작).
   */
  memberCanPin?: boolean;
  onEditSave: (content: string) => void | Promise<void>;
  onDelete: () => void | Promise<void>;
  onToggleReaction?: (emoji: string, currentlyByMe: boolean) => void;
  onOpenThread?: (rootId: string) => void;
  /**
   * task-045 iter1: pin/unpin 핸들러. 부모가 wsId 존재 + viewerRole
   * OWNER/ADMIN 일 때만 전달; 그 외에는 undefined → 메뉴 hide.
   */
  onPin?: () => void | Promise<void>;
  onUnpin?: () => void | Promise<void>;
  /**
   * S51 (FR-PS-07/13): 개인 저장 토글. 부모가 전달하면 툴바에 북마크 아이콘이
   * 노출되고, 클릭 시 저장/해제를 낙관적으로 토글한다. `isSaved` 가 true 면 채워진
   * (accent) 아이콘, false 면 외곽선 아이콘으로 렌더한다. tmp(낙관적 send) 행에는
   * 부모가 전달하지 않는다(서버 id 부재).
   */
  onToggleSave?: (currentlySaved: boolean) => void | Promise<void>;
  isSaved?: boolean;
  /**
   * S03 (FR-MSG-05): retry a failed optimistic send. Passed only for rows
   * whose `sendState === 'failed'`; re-fires with the SAME clientNonce
   * encoded in `msg.id`.
   */
  onRetry?: () => void;
  /**
   * S24 (FR-RS-08): "미읽으로 표시". 부모가 채널 컨텍스트(useMarkUnread)를
   * 알 때만 전달 — 이 메시지 직전으로 읽음 커서를 되돌린다(後進). optimistic/
   * tmp 행(아직 서버 id 없음)에는 부모가 전달하지 않거나 hide 처리한다.
   */
  onMarkUnread?: () => void | Promise<void>;
  /**
   * S64 (FR-RM11): 메시지 신고. 부모(MessageList)가 워크스페이스 채널(wsId 존재) +
   * 타인 메시지일 때만 전달한다 — 전달되면 메뉴에 "메시지 신고" 항목이 노출되고,
   * 클릭 시 ReportModal 을 연다. tmp/본인 메시지/DM 에는 부모가 전달하지 않는다.
   */
  onReport?: () => void;
  /**
   * S34 (FR-TH-03): reply bar 의 최근 답글자(recentReplyUserIds) 아바타를 실제
   * 표시명으로 그리기 위한 userId→이름 resolver. 부모(MessageList)가 보유한
   * 워크스페이스 멤버 맵(nameById) + DM 참가자 fallback(extraNames)을 합친
   * 함수를 넘긴다. 미전달이거나 특정 uid 가 맵에 없으면 chip 은 seed-color
   * fallback(이름 없는 결정적 색상 점)을 유지한다 — 과한 prop drilling 없이
   * 접근 가능한 범위에서만 표시명을 입힌다.
   */
  resolveName?: (userId: string) => string | undefined;
  /**
   * S42 (FR-PK01/PK03/PK04): 이모지 피커에 그대로 전달되는 퀵 반응 / 최근 이모지 /
   * 기본 스킨톤. 부모(MessageList)가 emoji-picker-data 를 단일 쿼리로 읽어 사용자
   * 우선·없으면 워크스페이스 기본을 합성해 넘긴다 — per-row useQuery 를 피해 정적
   * 렌더(provider-less) 회귀를 막는다. 미전달 시 피커는 종전 동작 그대로.
   */
  pickerQuickReactions?: string[];
  pickerRecentEmojis?: string[];
  pickerDefaultSkinTone?: number;
};

export function MessageItem({
  msg,
  isMine,
  workspaceId,
  isContinuation,
  authorName,
  authorRole,
  mentions,
  viewerRole,
  memberCanPin = true,
  onEditSave,
  onDelete,
  onToggleReaction,
  onOpenThread,
  onPin,
  onUnpin,
  onToggleSave,
  isSaved,
  onRetry,
  onMarkUnread,
  onReport,
  resolveName,
  pickerQuickReactions,
  pickerRecentEmojis,
  pickerDefaultSkinTone,
}: Props): JSX.Element {
  // S03 (FR-MSG-04/05): client-only optimistic send state. 'pending' renders a
  // muted/clock affordance; 'failed' renders the "다시 시도" retry control.
  const sendState = (msg as MessageDto & { sendState?: 'pending' | 'failed' }).sendState;
  const badge = roleBadgeLabel(authorRole);
  const customEmojis = useCustomEmojiLookup();
  const [editing, setEditing] = useState<string | null>(null);
  // task-041 A-2 (R3 follow-up): mutation-pending state surfaces a
  // skeleton on the row while edit/delete is in flight. On failure,
  // notify the user via toast so the silent rollback path of 040 R3
  // (covered for `send`) extends to `update`/`delete` as well.
  const [editPending, setEditPending] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  // task-042 R0 F4 (review M3 follow): track mount state so setState
  // in the mutation finally-blocks doesn't fire after unmount —
  // happens when the user channel-switches mid-delete and React 18
  // logs a console.error.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);
  const safeSet = <T,>(setter: (v: T) => void, value: T): void => {
    if (isMountedRef.current) setter(value);
  };
  const [pickerOpen, setPickerOpen] = useState(false);
  // S40 (FR-RE05): reactor 전체 목록 모달이 보여줄 이모지. null 이면 닫힘.
  const [reactorEmoji, setReactorEmoji] = useState<string | null>(null);
  // The more-menu lives inside .qf-message__toolbar which the DS CSS
  // toggles to display:flex only on `.qf-message:hover`. Radix opens
  // its portal over the trigger's getBoundingClientRect(); if the
  // dropdown portal steals focus, the toolbar reverts to display:none,
  // the trigger's rect becomes 0,0, and Radix re-anchors to the viewport
  // top-left. Keep the toolbar visible while the menu is open.
  const [moreOpen, setMoreOpen] = useState(false);
  const notify = useNotifications((s) => s.push);
  // S76 (FR-PS-09): 24시간 시계 외관 설정(appearance 스토어 단일 출처). early-return
  // (msg.deleted) 보다 위에서 호출해 Rules of Hooks 를 지킨다.
  const clock24h = useClock24h();

  if (msg.deleted) {
    return (
      <div
        data-testid={`msg-deleted-${msg.id}`}
        role="note"
        aria-label="삭제된 메시지"
        className="px-[var(--s-7)] py-[var(--s-2)] text-[length:var(--fs-13)] italic text-text-muted"
      >
        (삭제된 메시지)
      </div>
    );
  }

  // DS mockup (§ Message · Reaction · Embed): head rows render the
  // avatar + meta; continuation rows reuse qf-message--cont to
  // collapse them. The same layout grid keeps the body/toolbar
  // columns aligned across both variants.
  const isHead = !isContinuation;
  // S06 (FR-MSG-12): head 행 시각 라벨 + hover tooltip(ISO 전체).
  // S76 (FR-PS-09): clock24h 외관 설정을 appearance 스토어에서 읽어 12/24시간제를 결정한다
  // (서버 단일 출처 → 스토어 → 시각 포맷). 미설정/기본은 false(12시간제 — DEFAULT_APPEARANCE).
  const headTimeLabel = formatMessageTime(msg.createdAt, new Date(), { clock24h });
  const isoTooltip = formatMessageTimeISO(msg.createdAt);
  // S06 (FR-MSG-10): continuation 행 hover gutter 에 표시할 시각(clock24h 설정 반영).
  const gutterTime = formatClockPart(new Date(msg.createdAt), clock24h);
  // S06 (FR-RC15, P2): 이모지 1~3개로만 구성된 본문은 32px 로 확대. AST 없는
  // legacy(content 평문) 행은 판정 불가 → 기본 크기(과확대 회피).
  const jumbo = isJumboEmoji(msg.contentAst);
  const attachments: AttachmentLite[] = msg.attachments ?? [];
  const messageUrl =
    typeof window !== 'undefined' ? `${window.location.pathname}?msg=${msg.id}` : '';
  // S37 (FR-MSG-17): "메시지 복사"의 정본 텍스트(평문 우선). 순수 헬퍼로 분리해
  // 우선순위(contentPlain → content → '')를 단위 테스트로 고정한다.
  const copyPlainText = resolveCopyPlainText(msg);

  const thread = msg.thread;
  // S33 fix-forward (MAJOR-2 + NIT-2): chip 가시성은 순수 게이트로 위임한다.
  // 삭제된 thread-root placeholder 는 chip 을 숨겨야 한다 — GET /thread 가
  // deletedAt:null 루트만 200 을 돌려주므로, 삭제 루트에서 chip 클릭 시 404.
  // (현재는 deleted 메시지가 컴포넌트 상단에서 조기 반환되어 이 라인에 닿지
  // 않지만, 게이트에 deleted 조건을 박아 회귀 방지선을 둔다.)
  const threadChipVisible = computeThreadChipVisible(msg, thread, !!onOpenThread);

  // task-041 A-2: skeleton overlay during edit/delete. Reduces opacity
  // + adds a small inline label so the user sees the row is being
  // mutated. data-mutation-pending hook for e2e selectors.
  const mutationPending = editPending || deletePending;

  return (
    <>
      <article
        data-testid={`msg-${msg.id}`}
        data-mutation-pending={mutationPending ? (deletePending ? 'delete' : 'edit') : undefined}
        // S03 (FR-MSG-04/05): optimistic send state for e2e + CSS dimming.
        data-send-state={sendState}
        style={
          mutationPending
            ? { opacity: 0.55, pointerEvents: 'none' }
            : sendState === 'pending'
              ? { opacity: 0.6 }
              : undefined
        }
        className={cn('qf-message group', isHead ? 'qf-message--head' : 'qf-message--cont')}
      >
        {isHead ? (
          // S75 (FR-PS-07): 워크스페이스 채널(workspaceId 존재)에서만 아바타를 프로필 팝오버
          // 트리거로 감싼다. DM-context(전역) 팝오버는 S75 OUT 이라 DM 에서는 종전대로 정적 아바타.
          // tmp(낙관적 send) 행은 서버 authorId 가 유효하므로 동일하게 동작한다.
          workspaceId ? (
            // F5 (a11y M-1): 아바타 트리거는 마우스 전용(tabIndex=-1 + aria-hidden)으로
            // 두어, 같은 유저의 작성자명 트리거를 단일 키보드 진입점으로 만든다(중복
            // 포커스 스톱 제거). 클릭/탭 동작은 그대로 유지된다.
            <ProfilePopover
              userId={msg.authorId}
              workspaceId={workspaceId}
              triggerProps={{ tabIndex: -1, 'aria-hidden': true }}
            >
              <Avatar
                name={authorName ?? msg.authorId.slice(0, 2)}
                size="md"
                className="qf-message__avatar"
              />
            </ProfilePopover>
          ) : (
            <Avatar
              name={authorName ?? msg.authorId.slice(0, 2)}
              size="md"
              className="qf-message__avatar"
            />
          )
        ) : (
          // DS contract for cont rows (§ Message · Reaction · Embed mockup):
          // render an avatar-shaped ghost in the first grid column.
          // `.qf-avatar--md` gives it the 40px intrinsic width the grid
          // `auto` column needs to size to, and DS rule
          // `.qf-message--cont .qf-message__avatar { visibility: hidden;
          // height: 0 }` hides it visually while preserving column width —
          // the body then lines up with head rows exactly.
          //
          // S06 (FR-MSG-10): DS `.qf-message__gutter-time` 는 avatar 칼럼에
          // 자리하며 평소 opacity:0, 행 hover 시 opacity:1 로 HH:MM 을 노출합니다.
          // ghost avatar 와 함께 같은 grid-column 1 에 두어 head 행과 정렬됩니다.
          <>
            <span className="qf-avatar qf-avatar--md qf-message__avatar" aria-hidden="true" />
            <time
              className="qf-message__gutter-time"
              dateTime={msg.createdAt}
              title={isoTooltip}
              data-testid={`msg-gutter-time-${msg.id}`}
            >
              {gutterTime}
            </time>
          </>
        )}
        <div className="min-w-0">
          {isHead ? (
            <div className="qf-message__meta">
              {/* S75 (FR-PS-07): 작성자명도 워크스페이스 채널에서 프로필 팝오버 트리거. */}
              {workspaceId ? (
                <ProfilePopover userId={msg.authorId} workspaceId={workspaceId}>
                  <span className="qf-message__author">{authorName ?? 'unknown'}</span>
                </ProfilePopover>
              ) : (
                <span className="qf-message__author">{authorName ?? 'unknown'}</span>
              )}
              {badge ? (
                <span data-testid={`msg-role-${msg.id}`} className="qf-badge qf-badge--accent">
                  {badge}
                </span>
              ) : null}
              <time className="qf-message__time" dateTime={msg.createdAt} title={isoTooltip}>
                {headTimeLabel}
              </time>
              {msg.edited ? (
                // S05 (FR-MSG-07) + S37 (FR-MSG-08): (수정됨) 뱃지. 워크스페이스
                // 채널이면 클릭 시 편집 이력 팝오버를 여는 트리거로 동작하고
                // (EditHistoryPopover 가 동일 data-testid 와 title 을 유지),
                // DM(workspaceId null/undefined)은 history 엔드포인트가 없어
                // 종전대로 정적 라벨만 표시한다. DS qf-message__time 토큰 재사용.
                workspaceId ? (
                  <EditHistoryPopover
                    workspaceId={workspaceId}
                    channelId={msg.channelId}
                    msgId={msg.id}
                    editedAt={msg.editedAt}
                    mentions={mentions}
                  />
                ) : (
                  <span
                    data-testid={`msg-edited-${msg.id}`}
                    className="qf-message__time"
                    title={msg.editedAt ? new Date(msg.editedAt).toLocaleString() : undefined}
                  >
                    (수정됨)
                  </span>
                )
              ) : null}
              {msg.pinnedAt ? (
                // task-045 iter1: pin marker. semantic + screen-reader
                // friendly — `<span role="img" aria-label="고정된 메시지">`
                // 로 SR 가 핀 상태를 인식. DS qf-i-pin icon 재사용.
                <span
                  role="img"
                  aria-label="고정된 메시지"
                  data-testid={`msg-pinned-${msg.id}`}
                  className="qf-message__time inline-flex items-center gap-0.5"
                  title={`pinned at ${new Date(msg.pinnedAt).toLocaleString()}`}
                >
                  <Icon name="pin" size="sm" />
                </span>
              ) : null}
            </div>
          ) : null}
          {editing !== null ? (
            <div className="mt-1 flex items-center gap-2">
              <input
                data-testid={`msg-edit-${msg.id}`}
                aria-label="메시지 편집"
                className="qf-input flex-1"
                value={editing}
                onChange={(e) => setEditing(e.target.value)}
                onKeyDown={async (e) => {
                  // task-021-R2-ime-edit-half-saves: same IME guard as
                  // MessageComposer / ThreadPanel — Enter during Korean
                  // IME composition used to save a half-formed syllable.
                  const native = e.nativeEvent as KeyboardEvent & { isComposing?: boolean };
                  if (native.isComposing || e.keyCode === 229) return;
                  if (e.key === 'Enter') {
                    setEditPending(true);
                    try {
                      await onEditSave(editing);
                      safeSet(setEditing, null);
                    } catch {
                      if (isMountedRef.current) {
                        notify({
                          variant: 'danger',
                          title: '메시지 수정 실패',
                          body: '잠시 후 다시 시도하세요.',
                          ttlMs: 4000,
                        });
                      }
                    } finally {
                      safeSet(setEditPending, false);
                    }
                  }
                  if (e.key === 'Escape') setEditing(null);
                }}
                autoFocus
                disabled={editPending}
              />
              <button
                type="button"
                data-testid={`msg-edit-save-${msg.id}`}
                onClick={async () => {
                  setEditPending(true);
                  try {
                    await onEditSave(editing);
                    safeSet(setEditing, null);
                  } catch {
                    if (isMountedRef.current) {
                      notify({
                        variant: 'danger',
                        title: '메시지 수정 실패',
                        body: '잠시 후 다시 시도하세요.',
                        ttlMs: 4000,
                      });
                    }
                  } finally {
                    safeSet(setEditPending, false);
                  }
                }}
                disabled={editPending}
                className="qf-btn qf-btn--ghost qf-btn--sm"
              >
                {editPending ? '저장 중…' : '저장'}
              </button>
            </div>
          ) : (
            <div
              data-testid={`msg-content-${msg.id}`}
              data-jumbo={jumbo ? 'true' : undefined}
              className={cn(
                'qf-message__body',
                // S06 (FR-RC15): 이모지 1~3개 본문은 32px 확대. DS 토큰 alias
                // (--fs-32 / --lh-tight) 를 Tailwind arbitrary 로만 사용(raw px 금지).
                jumbo && 'text-[length:var(--fs-32)] leading-[var(--lh-tight)]',
              )}
            >
              {/* S02: 서버가 contentAst 를 채운 신규 메시지는 ReDoS-안전 AST
                 렌더 경로(renderAst — 선형, 한도 enforce 통과한 트리)를 사용.
                 contentAst 가 없는 legacy row 는 기존 정규식 렌더로 폴백. */}
              {msg.contentAst
                ? renderAst(msg.contentAst, customEmojis.byName, mentions)
                : renderMessageContent(msg.content ?? '', customEmojis.byName)}
              {/* S03 (FR-MSG-05): failed optimistic send — keep the bubble
                 visible with a "다시 시도" control that re-fires the SAME
                 clientNonce (encoded in msg.id). 'pending' just dims the row
                 via the data-attr below. */}
              {sendState === 'failed' ? (
                <div
                  data-testid={`msg-send-failed-${msg.id}`}
                  className="qf-message__send-failed mt-1 flex items-center gap-2 text-xs"
                >
                  {/* S35 fix-forward (DS 토큰화): DS 미정의 `qf-text-danger` →
                      등록된 --danger-400 토큰(SystemMessage.tsx TONE_CLASS 와 동일). */}
                  <span role="alert" className="text-[color:var(--danger-400)]">
                    전송 실패
                  </span>
                  {onRetry ? (
                    <button
                      type="button"
                      data-testid={`msg-retry-${msg.id}`}
                      onClick={onRetry}
                      className="qf-btn qf-btn--ghost qf-btn--sm"
                    >
                      다시 시도
                    </button>
                  ) : null}
                </div>
              ) : null}
              {attachments.length > 0 ? <AttachmentsList attachments={attachments} /> : null}
              {/* S60 (D11 · FR-RC07/08): link unfurl `.qf-embed` 카드.
                 서버가 비동기 unfurl 해 push 한 msg.embeds 가 있으면 그것을 렌더한다
                 (이미지는 백엔드 프록시 경로 · suppressedAt 카드는 hide). 없으면 종전
                 task-045 lazy-fetch(/links/preview)로 폴백한다(서버가 아직 push 안 한 호환). */}
              {(() => {
                const serverEmbeds = msg.embeds ?? [];
                if (serverEmbeds.length > 0) {
                  return serverEmbeds.map((e) => <LinkPreview key={`embed-${e.id}`} embed={e} />);
                }
                const urls = extractMessageUrls(msg.content ?? '');
                return urls.length > 0
                  ? urls.map((u) => <LinkPreview key={`embed-${u}`} url={u} />)
                  : null;
              })()}
              {onToggleReaction ? (
                <ReactionBar
                  reactions={msg.reactions ?? []}
                  pickerOpen={pickerOpen}
                  onPickerOpenChange={setPickerOpen}
                  onToggle={(emoji, byMe) => onToggleReaction(emoji, byMe)}
                  // S40 (FR-RE05): 칩 옆 보조 버튼으로 reactor 전체 목록 모달을 연다.
                  onShowReactors={(emoji) => setReactorEmoji(emoji)}
                  customEmojis={customEmojis.list.map((ce) => ({
                    id: ce.id,
                    name: ce.name,
                    url: ce.url,
                  }))}
                  quickReactions={pickerQuickReactions}
                  recentEmojis={pickerRecentEmojis}
                  defaultSkinTone={pickerDefaultSkinTone}
                />
              ) : null}
              {onToggleReaction ? (
                <ReactionUsersModal
                  messageId={msg.id}
                  emoji={reactorEmoji}
                  open={reactorEmoji !== null}
                  onOpenChange={(o) => {
                    if (!o) setReactorEmoji(null);
                  }}
                />
              ) : null}
            </div>
          )}
        </div>
        {editing === null ? (
          <div
            className={cn('qf-message__toolbar absolute', 'group-hover:!flex', moreOpen && '!flex')}
          >
            {onToggleReaction ? (
              <button
                type="button"
                data-testid={`msg-react-btn-${msg.id}`}
                onClick={() => setPickerOpen((v) => !v)}
                aria-label="리액션 추가"
                // S39 (SHOULD 4): 이모지 선택 dialog 를 여는 버튼임을 SR 에 알린다.
                aria-haspopup="dialog"
                className="qf-btn qf-btn--ghost qf-btn--icon qf-btn--sm"
              >
                <Icon name="reaction-add" size="sm" />
              </button>
            ) : null}
            {/* S33 (FR-TH-01): 루트 메시지에만 'Reply in thread' 노출.
               답글(parentMessageId 보유)·낙관적(tmp-) 행은 게이트가 막는다. */}
            {onOpenThread && canStartThread(msg, true) ? (
              <button
                type="button"
                data-testid={`msg-thread-btn-${msg.id}`}
                onClick={() => onOpenThread(msg.id)}
                aria-label="스레드 열기"
                className="qf-btn qf-btn--ghost qf-btn--icon qf-btn--sm"
              >
                <Icon name="thread" size="sm" />
              </button>
            ) : null}
            {/* S51 (FR-PS-07/13): 개인 저장 북마크 토글. 저장됨이면 accent 색 +
               aria-pressed=true 로 채워진 상태를 표현한다(DS 토큰 var(--accent) — raw
               hex 미사용). 낙관적 토글: 부모(onToggleSave)가 즉시 캐시를 뒤집는다. */}
            {onToggleSave ? (
              <button
                type="button"
                data-testid={`msg-save-btn-${msg.id}`}
                onClick={() => void onToggleSave(isSaved === true)}
                aria-label={isSaved ? '저장 해제' : '저장'}
                aria-pressed={isSaved === true}
                className="qf-btn qf-btn--ghost qf-btn--icon qf-btn--sm"
                style={isSaved ? { color: 'var(--accent)' } : undefined}
              >
                <Icon name="bookmark" size="sm" />
              </button>
            ) : null}
            <DropdownRoot open={moreOpen} onOpenChange={setMoreOpen}>
              <DropdownTrigger asChild>
                <button
                  type="button"
                  data-testid={`msg-more-btn-${msg.id}`}
                  aria-label="메시지 메뉴"
                  className="qf-btn qf-btn--ghost qf-btn--icon qf-btn--sm"
                >
                  <Icon name="more" size="sm" />
                </button>
              </DropdownTrigger>
              <DropdownContent align="end">
                {isMine ? (
                  <DropdownItem onSelect={() => setEditing(msg.content ?? '')}>
                    <span data-testid={`msg-edit-btn-${msg.id}`}>메시지 수정</span>
                  </DropdownItem>
                ) : null}
                <DropdownItem
                  onSelect={async () => {
                    try {
                      // S37 (FR-MSG-17): 평문(contentPlain) 정본 우선 복사.
                      await navigator.clipboard.writeText(copyPlainText);
                      notify({
                        variant: 'success',
                        title: '복사됨',
                        body: '메시지 내용을 복사했어요.',
                      });
                    } catch {
                      notify({
                        variant: 'danger',
                        title: '복사 실패',
                        body: '브라우저가 복사를 차단했어요.',
                      });
                    }
                  }}
                >
                  <span data-testid={`msg-copy-text-${msg.id}`}>메시지 복사</span>
                </DropdownItem>
                <DropdownItem
                  onSelect={async () => {
                    try {
                      const full =
                        typeof window !== 'undefined'
                          ? window.location.origin + messageUrl
                          : messageUrl;
                      await navigator.clipboard.writeText(full);
                      notify({ variant: 'success', title: '링크 복사됨', body: full });
                    } catch {
                      notify({
                        variant: 'danger',
                        title: '복사 실패',
                        body: '브라우저가 복사를 차단했어요.',
                      });
                    }
                  }}
                >
                  <span data-testid={`msg-copy-link-${msg.id}`}>메시지 링크 복사</span>
                </DropdownItem>
                {onMarkUnread && !msg.id.startsWith('tmp-') ? (
                  // S24 (FR-RS-08): 이 메시지 직전으로 읽음 커서를 되돌린다(後進).
                  // 실패 시 토스트로 안내(낙관 갱신은 훅 onSuccess 가 권위 처리).
                  <DropdownItem
                    onSelect={async () => {
                      try {
                        await onMarkUnread();
                      } catch {
                        notify({
                          variant: 'danger',
                          title: '미읽음 표시 실패',
                          body: '잠시 후 다시 시도하세요.',
                          ttlMs: 4000,
                        });
                      }
                    }}
                  >
                    <span data-testid={`msg-mark-unread-${msg.id}`}>미읽음으로 표시</span>
                  </DropdownItem>
                ) : null}
                {onReport && !isMine && !msg.id.startsWith('tmp-') ? (
                  // S64 (FR-RM11): 타인 메시지 신고. 부모가 워크스페이스 채널 + 타인
                  // 메시지일 때만 전달한다. 클릭 시 ReportModal 을 연다(부모 소유).
                  <DropdownItem onSelect={() => onReport()}>
                    <span data-testid={`msg-report-${msg.id}`}>메시지 신고</span>
                  </DropdownItem>
                ) : null}
                {(viewerRole === 'OWNER' ||
                  viewerRole === 'ADMIN' ||
                  (viewerRole === 'MEMBER' && memberCanPin)) &&
                !msg.id.startsWith('tmp-') &&
                (onPin || onUnpin) ? (
                  <>
                    <DropdownSeparator />
                    {msg.pinnedAt ? (
                      onUnpin ? (
                        <DropdownItem
                          onSelect={async () => {
                            try {
                              await onUnpin();
                              notify({
                                variant: 'success',
                                title: '메시지 고정 해제',
                                ttlMs: 2000,
                              });
                            } catch {
                              notify({
                                variant: 'danger',
                                title: '고정 해제 실패',
                                body: '잠시 후 다시 시도하세요.',
                                ttlMs: 4000,
                              });
                            }
                          }}
                        >
                          <span data-testid={`msg-unpin-${msg.id}`}>메시지 고정 해제</span>
                        </DropdownItem>
                      ) : null
                    ) : onPin ? (
                      <DropdownItem
                        onSelect={async () => {
                          try {
                            await onPin();
                            notify({
                              variant: 'success',
                              title: '메시지 고정',
                              ttlMs: 2000,
                            });
                          } catch (e) {
                            const code = (e as { errorCode?: string } | undefined)?.errorCode;
                            notify({
                              variant: 'danger',
                              title: '고정 실패',
                              body:
                                code === 'MESSAGE_PIN_CAP_EXCEEDED'
                                  ? '채널당 최대 50개까지 고정할 수 있습니다'
                                  : '잠시 후 다시 시도하세요.',
                              ttlMs: 4000,
                            });
                          }
                        }}
                      >
                        <span data-testid={`msg-pin-${msg.id}`}>메시지 고정</span>
                      </DropdownItem>
                    ) : null}
                  </>
                ) : null}
                {isMine ? (
                  <>
                    <DropdownSeparator />
                    <DropdownItem
                      danger
                      onSelect={async () => {
                        // task-041 A-2 + task-042 R0 F4 + F5: surface
                        // delete pending state, success toast (review
                        // M4), failure toast, and unmount-safe setState
                        // (review M3). The mutation hook returns a
                        // Promise; await + try/catch.
                        setDeletePending(true);
                        try {
                          await onDelete();
                          // F5: success path — symmetric with failure
                          // toast so a slow successful delete is not a
                          // silent fade-and-vanish.
                          if (isMountedRef.current) {
                            notify({
                              variant: 'success',
                              title: '메시지 삭제 완료',
                              ttlMs: 2500,
                            });
                          }
                        } catch {
                          if (isMountedRef.current) {
                            notify({
                              variant: 'danger',
                              title: '메시지 삭제 실패',
                              body: '잠시 후 다시 시도하세요.',
                              ttlMs: 4000,
                            });
                          }
                        } finally {
                          safeSet(setDeletePending, false);
                        }
                      }}
                    >
                      <span data-testid={`msg-delete-${msg.id}`}>메시지 삭제</span>
                    </DropdownItem>
                  </>
                ) : null}
              </DropdownContent>
            </DropdownRoot>
          </div>
        ) : null}
      </article>
      {/* qf-thread-chip is a sibling of qf-message per DS sample — its
        left margin (88px) aligns with the message body column; putting
        it inside the message grid would double-indent. Rendered only
        when the root has at least one reply. */}
      {threadChipVisible && thread ? (
        <button
          type="button"
          data-testid={`thread-open-${msg.id}`}
          onClick={() => onOpenThread?.(msg.id)}
          className="qf-thread-chip"
          // S34 fix-forward (a11y BLOCKER #3): chip 의 시각 정보(답글 수 + 마지막
          // 답글 시각)를 aria-label 에 합쳐 SR 사용자도 내부 메타를 듣게 한다.
          // 종전엔 "N개 답글 보기" 단독이라 마지막 답글 시각이 SR 로 전달되지
          // 않았다. lastRepliedAt 이 없으면 시각 절을 생략한다.
          aria-label={
            (thread.hasUnread ? '안 읽은 답글 · ' : '') +
            (thread.lastRepliedAt
              ? `${thread.replyCount}개 답글 보기, 마지막 답글 ${formatMessageTime(
                  thread.lastRepliedAt,
                  new Date(),
                )}`
              : `${thread.replyCount}개 답글 보기`)
          }
        >
          {/* S36 (FR-TH-04 / FR-TH-11): per-viewer 미읽 답글이 있으면 파란 dot.
              DS 에 qf-thread-chip 전용 dot 클래스가 없어(grep 확인) app-layer 로
              합성하되 전부 DS 토큰만 사용한다(raw hex/px 없음): 색 var(--accent),
              원형 var(--r-pill). DS 4파일 무수정.
              S36 fix-forward (UI MEDIUM): 종전 var(--s-2)(4px)는 과소해 가시성이
              낮았다. var(--s-3)(8px)로 상향한다. dot 의 의미("안 읽은 답글")는 부모
              chip 의 aria-label 절(상단 'thread.hasUnread ? "안 읽은 답글 · "')로
              이미 SR 에 전달되므로, dot 자체는 aria-hidden 을 유지한다(SR 중복 발화
              방지). DS 등록 토큰만 사용 — raw px 없음. */}
          {thread.hasUnread ? (
            <span
              data-testid={`thread-unread-dot-${msg.id}`}
              aria-hidden="true"
              className="inline-block rounded-[var(--r-pill)]"
              style={{
                width: 'var(--s-3)',
                height: 'var(--s-3)',
                background: 'var(--accent)',
                flexShrink: 0,
              }}
            />
          ) : null}
          {thread.recentReplyUserIds.length > 0 ? (
            // S34 (FR-TH-03): 최초 답글자 최대 5명 아바타(오버랩). DS
            // `.qf-thread-chip__avatars`(-4px 오버랩) 재사용 — 신규 DS 클래스 0.
            // S34 fix-forward (DS HIGH #4): 표시명 유무와 무관하게 Avatar
            // primitive 로 단일화한다. Avatar 가 이니셜 + seed-color 를 내부에서
            // 처리하므로(중복 colorFromSeed / raw hsl 인라인 제거), 표시명을 풀면
            // 그 이름으로, 못 풀면 uid 로 Avatar 를 렌더한다.
            <div className="qf-thread-chip__avatars" aria-hidden="true">
              {thread.recentReplyUserIds.slice(0, 5).map((uid) => (
                <Avatar key={uid} name={resolveName?.(uid) ?? uid} size="xs" />
              ))}
            </div>
          ) : null}
          <span className="qf-thread-chip__count">{thread.replyCount}개 답글</span>
          {thread.lastRepliedAt ? (
            // S34 (FR-TH-03): latestReplyAt 을 절대 시각(toLocaleTimeString)이
            // 아니라 상대 시각(formatMessageTime — 오늘/어제/N일 전)으로 표시한다.
            // S34 fix-forward (a11y #3): <span> → <time dateTime title> 으로 바꿔
            // 기계 판독 가능 + hover ISO tooltip 을 제공한다(head/gutter <time> 패턴 일치).
            <time
              className="qf-thread-chip__last"
              dateTime={thread.lastRepliedAt}
              title={formatMessageTimeISO(thread.lastRepliedAt)}
            >
              · 마지막 답글 {formatMessageTime(thread.lastRepliedAt, new Date())}
            </time>
          ) : null}
          <span className="qf-thread-chip__cta">▸ 스레드 보기</span>
        </button>
      ) : null}
    </>
  );
}
