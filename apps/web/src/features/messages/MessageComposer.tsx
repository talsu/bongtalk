import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSendMessage } from './useMessages';
import { useCompose } from '../../stores/compose-store';
import { getSocket } from '../../lib/socket';
import { useNotifications } from '../../stores/notification-store';
import {
  DropdownRoot,
  DropdownTrigger,
  DropdownContent,
  DropdownItem,
  Icon,
} from '../../design-system/primitives';
import { EmojiPicker } from '../reactions/EmojiPicker';
import { useCustomEmojis } from '../emojis/useCustomEmojis';
import { uploadAttachment, type UploadedAttachment } from './useAttachmentUpload';
import { cn } from '../../lib/cn';

type Props = {
  workspaceId: string;
  channelId: string;
  channelName: string;
};

// Task-018-F: client-side safety margin for the typing ping cadence. The
// server throttles per (userId, channelId) at TYPING_THROTTLE_SEC (3 s),
// but re-emitting at 1.5 s keeps the indicator alive across brief pauses
// without flooding the socket. The server still enforces the floor.
const TYPING_EMIT_INTERVAL_MS = 1500;
// Single-line initial height (matches the DS composer mockup's
// `qf-input` one-row shape). Grows with content up to 200px, then
// scrolls internally.
const MIN_HEIGHT_PX = 22;
const MAX_HEIGHT_PX = 200;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function MessageComposer({ workspaceId, channelId, channelName }: Props): JSX.Element {
  const draft = useCompose((s) => s.drafts[channelId] ?? '');
  const setDraft = useCompose((s) => s.setDraft);
  const clearDraft = useCompose((s) => s.clearDraft);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastPingRef = useRef<number>(0);
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
  const uploading = jobs.filter((j) => j.status === 'uploading').length;

  useEffect(() => {
    textareaRef.current?.focus();
    lastPingRef.current = 0;
    setPending([]);
    setJobs([]);
    setEmojiOpen(false);
  }, [channelId]);

  // task-021-R1 reviewer HIGH fix: when the user switches channels
  // (or unmounts the composer entirely), send typing.stop for the
  // channel that the composer was mounted on so observers don't see
  // a stale indicator for up to 5s until Redis TTL.
  useEffect(() => {
    const prev = channelId;
    return () => {
      const socket = getSocket();
      if (socket?.connected) {
        socket.emit('typing.stop', { channelId: prev });
      }
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

  const maybePing = (): void => {
    const now = Date.now();
    if (now - lastPingRef.current < TYPING_EMIT_INTERVAL_MS) return;
    lastPingRef.current = now;
    const socket = getSocket();
    if (socket?.connected) socket.emit('typing.ping', { channelId });
  };

  const sendTypingStop = (): void => {
    const socket = getSocket();
    if (socket?.connected) socket.emit('typing.stop', { channelId });
    lastPingRef.current = 0;
  };

  const submit = (): void => {
    const trimmed = draft.trim();
    if (!trimmed && pending.length === 0) return;
    send(trimmed || ' ', pending.length > 0 ? pending.map((p) => p.id) : undefined);
    clearDraft(channelId);
    setPending([]);
    sendTypingStop();
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
    const arr = Array.from(files);
    const newJobs = arr.map((file) => ({
      id: crypto.randomUUID(),
      file,
      status: 'uploading' as const,
    }));
    setJobs((prev) => [...prev, ...newJobs]);
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
            onChange={(e) => {
              const next = e.target.value;
              setDraft(channelId, next);
              if (next.length > 0) maybePing();
              else sendTypingStop();
            }}
            onKeyDown={(e) => {
              // task-021-R1-ime-enter-half-sends: skip Enter when an IME
              // composition is in flight. `nativeEvent.isComposing` is
              // the standard signal; `keyCode === 229` covers older
              // browsers / Korean IMEs that dispatch the pseudo-key
              // before composition end.
              const native = e.nativeEvent as KeyboardEvent & { isComposing?: boolean };
              if (native.isComposing || e.keyCode === 229) return;
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            maxLength={4000}
            placeholder={`# ${channelName} 에 메시지…`}
            className="flex-1 resize-none bg-transparent outline-none placeholder:text-text-muted text-text"
            style={{ minHeight: `${MIN_HEIGHT_PX}px`, maxHeight: `${MAX_HEIGHT_PX}px` }}
          />
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
            (draft.trim().length === 0 && pending.length === 0)
          }
        />
      </form>
    </div>
  );
}
