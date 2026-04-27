import { useRef, useState } from 'react';
import { Button } from '../../design-system/primitives';
import { useNotifications } from '../../stores/notification-store';
import { useCustomEmojis, useDeleteCustomEmoji, useUploadCustomEmoji } from './useCustomEmojis';

const NAME_RE = /^[a-z0-9_]{2,32}$/;
const MAX_BYTES = 256 * 1024;
const ALLOWED_MIME = ['image/png', 'image/gif'];
const CAP = 100;

/**
 * task-037-D: workspace Settings "이모지 관리" tab.
 *
 * - OWNER / ADMIN only (visibility gated by the parent Settings overlay;
 *   server also re-gates the POST/DELETE routes with the Roles guard).
 * - File-picker + name input + grid with delete buttons. Drag-drop wires
 *   onDrop → the same upload handler the picker uses.
 * - Client-side validation matches the server: regex, mime allowlist,
 *   ≤256 KB, ≤100 total — catches the error before the presign call.
 */
export function WorkspaceEmojiManager({ workspaceId }: { workspaceId: string }): JSX.Element {
  const { data } = useCustomEmojis(workspaceId);
  const uploadMut = useUploadCustomEmoji(workspaceId);
  const deleteMut = useDeleteCustomEmoji(workspaceId);
  const notify = useNotifications((s) => s.push);

  const fileRef = useRef<HTMLInputElement>(null);
  const [stagedFile, setStagedFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const items = data?.items ?? [];
  const atCap = items.length >= CAP;

  const stage = (f: File | null): void => {
    setErr(null);
    if (!f) {
      setStagedFile(null);
      return;
    }
    if (!ALLOWED_MIME.includes(f.type)) {
      setErr(`png/gif만 가능합니다 (받은 mime: ${f.type || '없음'})`);
      return;
    }
    if (f.size > MAX_BYTES) {
      setErr(`256 KB 이하로 올려주세요 (현재 ${Math.round(f.size / 1024)} KB)`);
      return;
    }
    setStagedFile(f);
    if (!name) {
      // Seed the name from the filename (strip extension + lowercase).
      const bare = f.name
        .replace(/\.[^.]+$/, '')
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '_');
      setName(bare.slice(0, 32));
    }
  };

  const submit = async (): Promise<void> => {
    setErr(null);
    if (!stagedFile) {
      setErr('파일을 선택해주세요.');
      return;
    }
    if (!NAME_RE.test(name)) {
      setErr('이름은 a-z, 0-9, _ 만 쓸 수 있고 2~32자입니다.');
      return;
    }
    if (atCap) {
      setErr(`워크스페이스당 최대 ${CAP}개까지 업로드할 수 있어요.`);
      return;
    }
    try {
      await uploadMut.mutateAsync({ name, file: stagedFile });
      notify({ variant: 'success', title: '이모지 추가됨', body: `:${name}:` });
      setStagedFile(null);
      setName('');
      if (fileRef.current) fileRef.current.value = '';
    } catch (e) {
      const msg = (e as Error).message ?? '업로드 실패';
      setErr(msg);
    }
  };

  const remove = async (id: string, emojiName: string): Promise<void> => {
    if (
      !window.confirm(
        `:${emojiName}: 을(를) 삭제할까요? 기존 메시지의 :${emojiName}: 은(는) 평문으로 보이게 됩니다.`,
      )
    )
      return;
    try {
      await deleteMut.mutateAsync(id);
      notify({ variant: 'success', title: '삭제됨', body: `:${emojiName}:` });
    } catch (e) {
      notify({ variant: 'danger', title: '삭제 실패', body: (e as Error).message });
    }
  };

  return (
    <div data-testid="workspace-emoji-manager" className="flex flex-col gap-[var(--s-4)]">
      <div>
        <h3 className="font-semibold">이모지 관리</h3>
        <p className="text-[length:var(--fs-13)] text-text-secondary">
          png 또는 gif · 256 KB 이하 · 최대 {CAP}개 ({items.length}/{CAP})
        </p>
      </div>

      <div
        data-testid="emoji-dropzone"
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) stage(f);
        }}
        className="qf-field rounded-[var(--r-md)] border-2 border-dashed p-[var(--s-4)]"
        style={{
          borderColor: dragOver ? 'var(--accent)' : 'var(--border-subtle)',
          background: dragOver ? 'var(--bg-selected)' : 'transparent',
        }}
      >
        <div className="flex flex-col gap-[var(--s-2)]">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/gif"
            aria-label="커스텀 이모지 이미지 파일 선택"
            data-testid="emoji-file-input"
            onChange={(e) => stage(e.target.files?.[0] ?? null)}
          />
          {stagedFile ? (
            <p className="text-[length:var(--fs-13)] text-text-muted">
              선택됨: {stagedFile.name} ({Math.round(stagedFile.size / 1024)} KB)
            </p>
          ) : (
            <p className="text-[length:var(--fs-13)] text-text-muted">
              또는 파일을 여기로 드래그하세요.
            </p>
          )}
          <label className="qf-field">
            <span className="qf-field__label">이름 (:name:)</span>
            <input
              data-testid="emoji-name-input"
              className="qf-input"
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
              placeholder="party_parrot"
              maxLength={32}
            />
          </label>
          <div className="flex gap-[var(--s-2)]">
            <Button
              data-testid="emoji-upload-submit"
              onClick={submit}
              disabled={uploadMut.isPending || atCap}
            >
              {uploadMut.isPending ? '업로드 중…' : '추가'}
            </Button>
            {stagedFile ? (
              <Button
                variant="ghost"
                onClick={() => {
                  setStagedFile(null);
                  setName('');
                  if (fileRef.current) fileRef.current.value = '';
                }}
              >
                취소
              </Button>
            ) : null}
          </div>
          {err ? (
            <p className="qf-field__error" data-testid="emoji-upload-error">
              {err}
            </p>
          ) : null}
        </div>
      </div>

      <div
        data-testid="emoji-grid"
        className="grid gap-[var(--s-3)]"
        style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))' }}
      >
        {items.map((ce) => (
          <div
            key={ce.id}
            data-testid={`emoji-row-${ce.name}`}
            className="flex flex-col items-center gap-[var(--s-1)] p-[var(--s-2)] rounded-[var(--r-md)] bg-bg-subtle"
          >
            <img
              src={ce.url}
              alt={ce.name}
              style={{ width: 48, height: 48, objectFit: 'contain' }}
            />
            <code className="text-[length:var(--fs-11)]">:{ce.name}:</code>
            <button
              type="button"
              data-testid={`emoji-delete-${ce.name}`}
              onClick={() => remove(ce.id, ce.name)}
              className="qf-btn qf-btn--ghost qf-btn--sm"
              disabled={deleteMut.isPending}
            >
              삭제
            </button>
          </div>
        ))}
        {items.length === 0 ? (
          <p className="col-span-full text-center text-text-muted py-[var(--s-5)]">
            아직 업로드된 이모지가 없어요.
          </p>
        ) : null}
      </div>
    </div>
  );
}
