import { useId, useRef, useState } from 'react';
import { Button } from '../../design-system/primitives';
import { useNotifications } from '../../stores/notification-store';
import {
  useAddEmojiAlias,
  useCustomEmojis,
  useDeleteCustomEmoji,
  useRemoveEmojiAlias,
  useUploadCustomEmoji,
} from './useCustomEmojis';

const NAME_RE = /^[a-z0-9_]{2,32}$/;
const ALIAS_RE = /^[a-z0-9_]{2,32}$/;
const MAX_BYTES = 256 * 1024;
const ALLOWED_MIME = ['image/png', 'image/gif'];
const CAP = 100;
const ALIAS_CAP = 10;

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
  const addAliasMut = useAddEmojiAlias(workspaceId);
  const removeAliasMut = useRemoveEmojiAlias(workspaceId);
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

  // S42 (FR-EM05): 별칭 추가/삭제 핸들러. 클라 검증(slug·≤10)은 서버와 동일하게
  // 미리 걸러 presign-없는 단순 POST/DELETE 의 즉시 에러를 줄인다(서버가 권위 검증).
  //
  // S42 fix-forward (A-2): addAlias 는 실패 시 에러 문구를 반환한다(성공이면 null).
  // 에디터가 이 값을 인라인 에러 영역(aria-invalid + aria-describedby)에 연결하고,
  // 토스트는 보조 알림으로 유지한다 — 형식/한도/충돌(409) 모두 스크린리더에 닿게 한다.
  const addAlias = async (
    emojiId: string,
    alias: string,
    current: string[],
  ): Promise<string | null> => {
    const slug = alias.trim().toLowerCase();
    if (!ALIAS_RE.test(slug)) {
      const msg = '별칭은 a-z, 0-9, _ 만 쓸 수 있고 2~32자입니다.';
      notify({ variant: 'danger', title: '별칭 형식 오류', body: msg });
      return msg;
    }
    if (current.length >= ALIAS_CAP) {
      const msg = `이모지당 최대 ${ALIAS_CAP}개까지 추가할 수 있어요.`;
      notify({ variant: 'danger', title: '별칭 한도', body: msg });
      return msg;
    }
    try {
      await addAliasMut.mutateAsync({ emojiId, alias: slug });
      notify({ variant: 'success', title: '별칭 추가됨', body: `:${slug}:` });
      return null;
    } catch (e) {
      const msg = (e as Error).message ?? '별칭 추가 실패';
      notify({ variant: 'danger', title: '별칭 추가 실패', body: msg });
      return msg;
    }
  };

  const removeAlias = async (emojiId: string, alias: string): Promise<void> => {
    try {
      await removeAliasMut.mutateAsync({ emojiId, alias });
      notify({ variant: 'success', title: '별칭 삭제됨', body: `:${alias}:` });
    } catch (e) {
      notify({ variant: 'danger', title: '별칭 삭제 실패', body: (e as Error).message });
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
        style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}
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
              aria-label={`:${ce.name}: 이모지 삭제`}
              onClick={() => remove(ce.id, ce.name)}
              className="qf-btn qf-btn--ghost qf-btn--sm"
              disabled={deleteMut.isPending}
            >
              삭제
            </button>
            <EmojiAliasEditor
              emojiName={ce.name}
              aliases={ce.aliases ?? []}
              onAdd={(alias) => addAlias(ce.id, alias, ce.aliases ?? [])}
              onRemove={(alias) => removeAlias(ce.id, alias)}
              busy={addAliasMut.isPending || removeAliasMut.isPending}
              cap={ALIAS_CAP}
            />
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

/**
 * S42 (FR-EM05): 이모지 한 개의 별칭 추가/삭제 UI(OWNER/ADMIN). 부모가 권한 가시성을
 * 통제하고(WorkspaceEmojiManager 는 Settings 오버레이에서 OWNER/ADMIN 에게만 렌더),
 * 서버가 라우트를 재게이트한다. 신규 DS 0 · 기존 qf-* / 토큰만 사용.
 */
function EmojiAliasEditor({
  emojiName,
  aliases,
  onAdd,
  onRemove,
  busy,
  cap,
}: {
  emojiName: string;
  aliases: string[];
  // S42 fix-forward (A-2): onAdd 는 실패 시 에러 문구를, 성공이면 null 을 반환한다.
  onAdd: (alias: string) => Promise<string | null>;
  onRemove: (alias: string) => void;
  busy: boolean;
  cap: number;
}): JSX.Element {
  const [value, setValue] = useState('');
  // S42 fix-forward (A-2): 인라인 에러 문구. aria-invalid + aria-describedby 로
  // 입력 필드와 연결해 형식/한도/충돌(409)을 스크린리더에 전달한다(토스트는 보조).
  const [aliasError, setAliasError] = useState<string | null>(null);
  const errorId = useId();
  const atCap = aliases.length >= cap;

  const submit = async (): Promise<void> => {
    if (!value) return;
    const err = await onAdd(value);
    if (err) {
      setAliasError(err);
      return;
    }
    setAliasError(null);
    setValue('');
  };

  return (
    <div
      data-testid={`emoji-aliases-${emojiName}`}
      className="flex w-full flex-col gap-[var(--s-1)]"
    >
      {aliases.length > 0 ? (
        <div className="flex flex-wrap justify-center gap-[var(--s-1)]">
          {aliases.map((alias) => (
            <span
              key={alias}
              data-testid={`emoji-alias-chip-${alias}`}
              className="qf-badge inline-flex items-center text-[length:var(--fs-11)]"
            >
              :{alias}:
              <button
                type="button"
                aria-label={`별칭 :${alias}: 삭제`}
                data-testid={`emoji-alias-remove-${alias}`}
                onClick={() => onRemove(alias)}
                disabled={busy}
                className="ml-[var(--s-1)]"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {!atCap ? (
        <>
          <div className="flex gap-[var(--s-1)]">
            <input
              data-testid={`emoji-alias-input-${emojiName}`}
              aria-label={`:${emojiName}: 별칭 추가`}
              aria-invalid={aliasError ? true : undefined}
              aria-describedby={aliasError ? errorId : undefined}
              className="qf-input flex-1 text-[length:var(--fs-11)]"
              value={value}
              onChange={(e) => {
                setValue(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''));
                if (aliasError) setAliasError(null);
              }}
              placeholder="별칭 추가"
              maxLength={32}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
            <button
              type="button"
              data-testid={`emoji-alias-add-${emojiName}`}
              aria-label={`:${emojiName}: 별칭 추가`}
              onClick={() => void submit()}
              disabled={busy || value.length === 0}
              className="qf-btn qf-btn--ghost qf-btn--sm"
            >
              +
            </button>
          </div>
          {aliasError ? (
            <p
              id={errorId}
              data-testid={`emoji-alias-error-${emojiName}`}
              className="qf-field__error text-[length:var(--fs-11)]"
            >
              {aliasError}
            </p>
          ) : null}
        </>
      ) : (
        <p
          data-testid={`emoji-alias-cap-${emojiName}`}
          role="status"
          aria-live="polite"
          className="text-center text-[length:var(--fs-11)] text-text-muted"
        >
          별칭 {cap}개 한도
        </p>
      )}
    </div>
  );
}
