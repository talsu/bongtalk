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
import { ReactionBar } from '../reactions/ReactionBar';
import { useCustomEmojiLookup } from '../emojis/CustomEmojiContext';
import { roleBadgeLabel } from './roleBadge';
import { renderMessageContent } from './parseContent';
import { AttachmentsList, type AttachmentLite } from './AttachmentsList';

type Props = {
  msg: MessageDto;
  isMine: boolean;
  /**
   * True when the previous message is from the same author within the
   * grouping window (see MessageList). Collapses avatar + meta to
   * produce Discord-like read flow.
   */
  isContinuation?: boolean;
  authorName?: string;
  authorRole?: WorkspaceRole | null;
  onEditSave: (content: string) => void | Promise<void>;
  onDelete: () => void | Promise<void>;
  onToggleReaction?: (emoji: string, currentlyByMe: boolean) => void;
  onOpenThread?: (rootId: string) => void;
};

export function MessageItem({
  msg,
  isMine,
  isContinuation,
  authorName,
  authorRole,
  onEditSave,
  onDelete,
  onToggleReaction,
  onOpenThread,
}: Props): JSX.Element {
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
  // The more-menu lives inside .qf-message__toolbar which the DS CSS
  // toggles to display:flex only on `.qf-message:hover`. Radix opens
  // its portal over the trigger's getBoundingClientRect(); if the
  // dropdown portal steals focus, the toolbar reverts to display:none,
  // the trigger's rect becomes 0,0, and Radix re-anchors to the viewport
  // top-left. Keep the toolbar visible while the menu is open.
  const [moreOpen, setMoreOpen] = useState(false);
  const notify = useNotifications((s) => s.push);

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
  const attachments: AttachmentLite[] = (msg.attachments ?? []) as AttachmentLite[];
  const messageUrl =
    typeof window !== 'undefined' ? `${window.location.pathname}?msg=${msg.id}` : '';

  const thread = msg.thread;
  const threadChipVisible = !!onOpenThread && !!thread && thread.replyCount > 0;

  // task-041 A-2: skeleton overlay during edit/delete. Reduces opacity
  // + adds a small inline label so the user sees the row is being
  // mutated. data-mutation-pending hook for e2e selectors.
  const mutationPending = editPending || deletePending;

  return (
    <>
      <article
        data-testid={`msg-${msg.id}`}
        data-mutation-pending={mutationPending ? (deletePending ? 'delete' : 'edit') : undefined}
        style={mutationPending ? { opacity: 0.55, pointerEvents: 'none' } : undefined}
        className={cn('qf-message group', isHead ? 'qf-message--head' : 'qf-message--cont')}
      >
        {isHead ? (
          <Avatar
            name={authorName ?? msg.authorId.slice(0, 2)}
            size="md"
            className="qf-message__avatar"
          />
        ) : (
          // DS contract for cont rows (§ Message · Reaction · Embed mockup):
          // render an avatar-shaped ghost in the first grid column.
          // `.qf-avatar--md` gives it the 40px intrinsic width the grid
          // `auto` column needs to size to, and DS rule
          // `.qf-message--cont .qf-message__avatar { visibility: hidden;
          // height: 0 }` hides it visually while preserving column width —
          // the body then lines up with head rows exactly.
          <span className="qf-avatar qf-avatar--md qf-message__avatar" aria-hidden="true" />
        )}
        <div className="min-w-0">
          {isHead ? (
            <div className="qf-message__meta">
              <span className="qf-message__author">{authorName ?? 'unknown'}</span>
              {badge ? (
                <span data-testid={`msg-role-${msg.id}`} className="qf-badge qf-badge--accent">
                  {badge}
                </span>
              ) : null}
              <time className="qf-message__time">
                {new Date(msg.createdAt).toLocaleTimeString()}
              </time>
              {msg.edited ? (
                <span data-testid={`msg-edited-${msg.id}`} className="qf-message__time">
                  (수정됨)
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
            <div data-testid={`msg-content-${msg.id}`} className="qf-message__body">
              {renderMessageContent(msg.content ?? '', customEmojis.byName)}
              {attachments.length > 0 ? <AttachmentsList attachments={attachments} /> : null}
              {onToggleReaction ? (
                <ReactionBar
                  reactions={msg.reactions ?? []}
                  pickerOpen={pickerOpen}
                  onPickerOpenChange={setPickerOpen}
                  onToggle={(emoji, byMe) => onToggleReaction(emoji, byMe)}
                  customEmojis={customEmojis.list.map((ce) => ({
                    id: ce.id,
                    name: ce.name,
                    url: ce.url,
                  }))}
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
                className="qf-btn qf-btn--ghost qf-btn--icon qf-btn--sm"
              >
                <Icon name="reaction-add" size="sm" />
              </button>
            ) : null}
            {onOpenThread && !msg.id.startsWith('tmp-') && !msg.parentMessageId ? (
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
                      await navigator.clipboard.writeText(msg.content ?? '');
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
                  <span data-testid={`msg-copy-text-${msg.id}`}>텍스트 복사</span>
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
          aria-label={`${thread.replyCount}개 답글 보기`}
        >
          {thread.recentReplyUserIds.length > 0 ? (
            <div className="qf-thread-chip__avatars" aria-hidden="true">
              {thread.recentReplyUserIds.slice(0, 3).map((uid) => (
                <span
                  key={uid}
                  className="qf-avatar qf-avatar--xs"
                  style={{ background: colorFromSeed(uid) }}
                />
              ))}
            </div>
          ) : null}
          <span className="qf-thread-chip__count">{thread.replyCount}개 답글</span>
          {thread.lastRepliedAt ? (
            <span className="qf-thread-chip__last">
              · 마지막 답글 {new Date(thread.lastRepliedAt).toLocaleTimeString()}
            </span>
          ) : null}
          <span className="qf-thread-chip__cta">▸ 스레드 보기</span>
        </button>
      ) : null}
    </>
  );
}

// Deterministic HSL from a seed string — matches Avatar's colorFromSeed
// so the chip's recent-replier avatars share the colour scheme they'll
// have in the thread panel. Keeps the DS palette (hue bounded to the
// accent family).
function colorFromSeed(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = h * 31 + seed.charCodeAt(i);
  const hues = [258, 272, 290, 240, 220, 200, 310, 270];
  return `hsl(${hues[Math.abs(h) % hues.length]} 65% 55%)`;
}
