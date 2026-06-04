import { useEffect, useRef, useState } from 'react';
import {
  WS_NICKNAME_MAX,
  WS_BIO_MAX,
  WS_AVATAR_MAX_BYTES,
  WS_AVATAR_ALLOWED_MIME,
  type UpdateWorkspaceMemberProfileInput,
} from '@qufox/shared-types';
import { Icon } from '../../design-system/primitives';
import { useNotifications } from '../../stores/notification-store';
import {
  useWorkspaceProfile,
  useUpdateWorkspaceProfile,
  useWorkspaceAvatarPresign,
  useWorkspaceAvatarFinalize,
  useWorkspaceAvatarDelete,
} from './useWorkspaceProfile';
import { uploadAvatarBlob } from '../users/avatarUpload';

/**
 * S74 (D14 / FR-PS-06): 워크스페이스별 프로필 편집(닉네임 ≤32 · 아바타 · About Me ≤190).
 *
 * 전역 프로필을 덮어쓰지 않고 이 워크스페이스 한정 오버라이드만 둔다. 빈 값으로 저장하면
 * 오버라이드를 비워(전역값 폴백) 되돌린다. 아바타는 8MB/MIME 클라 검증 + presign→POST→finalize.
 */
const WS_MIME_ACCEPT = WS_AVATAR_ALLOWED_MIME.join(',');

export function WorkspaceProfilePanel({ workspaceId }: { workspaceId: string }): JSX.Element {
  const notify = useNotifications((s) => s.push);
  const { data: profile, isLoading, isError } = useWorkspaceProfile(workspaceId);
  const update = useUpdateWorkspaceProfile(workspaceId);
  const presign = useWorkspaceAvatarPresign(workspaceId);
  const finalize = useWorkspaceAvatarFinalize(workspaceId);
  const removeAvatar = useWorkspaceAvatarDelete(workspaceId);

  const [nickname, setNickname] = useState('');
  const [workspaceBio, setWorkspaceBio] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!profile) return;
    setNickname(profile.nickname ?? '');
    setWorkspaceBio(profile.workspaceBio ?? '');
  }, [profile]);

  if (isLoading) {
    return (
      <div role="status" className="text-text-muted">
        불러오는 중…
      </div>
    );
  }
  if (isError || !profile) {
    return <p className="text-text-muted">워크스페이스 프로필을 불러올 수 없습니다.</p>;
  }

  const onPickAvatar = (): void => fileRef.current?.click();

  const onAvatarSelected = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!(WS_AVATAR_ALLOWED_MIME as readonly string[]).includes(file.type)) {
      notify({
        variant: 'danger',
        title: '지원하지 않는 형식',
        body: 'PNG·JPG·WEBP 만 가능합니다.',
      });
      return;
    }
    if (file.size > WS_AVATAR_MAX_BYTES) {
      notify({
        variant: 'danger',
        title: '파일이 너무 큽니다',
        body: '최대 8MB 까지 업로드할 수 있습니다.',
      });
      return;
    }
    try {
      const { key, url, fields } = await presign.mutateAsync({
        contentType: file.type,
        sizeBytes: file.size,
      });
      await uploadAvatarBlob(url, fields, file);
      await finalize.mutateAsync(key);
      notify({ variant: 'success', title: '워크스페이스 아바타를 변경했습니다.' });
    } catch (err) {
      notify({ variant: 'danger', title: '아바타 업로드 실패', body: (err as Error).message });
    }
  };

  const onRemoveAvatar = async (): Promise<void> => {
    try {
      await removeAvatar.mutateAsync();
      notify({ variant: 'success', title: '워크스페이스 아바타를 제거했습니다.' });
    } catch (err) {
      notify({ variant: 'danger', title: '아바타 제거 실패', body: (err as Error).message });
    }
  };

  const onSave = async (): Promise<void> => {
    const norm = (raw: string): string | null => {
      const t = raw.trim();
      return t.length === 0 ? null : t;
    };
    // 변경된 필드만 PATCH(빈 값 → null = 전역 폴백으로 되돌림).
    const patch: UpdateWorkspaceMemberProfileInput = {};
    const nick = norm(nickname);
    if (nick !== (profile.nickname ?? null)) patch.nickname = nick;
    const wbio = norm(workspaceBio);
    if (wbio !== (profile.workspaceBio ?? null)) patch.workspaceBio = wbio;
    try {
      await update.mutateAsync(patch);
      notify({ variant: 'success', title: '워크스페이스 프로필을 저장했습니다.' });
    } catch (err) {
      notify({ variant: 'danger', title: '저장 실패', body: (err as Error).message });
    }
  };

  const saving = update.isPending;

  // a11y HIGH-2: ws아바타 img alt 에 사용자명(닉네임)을 포함해 식별 가능하게 한다.
  const avatarAlt = `${nickname || profile.nickname || ''}의 워크스페이스 프로필 사진`.trim();

  return (
    <form
      data-testid="ws-profile-panel"
      // a11y HIGH-3: 폼 접근명.
      aria-label="워크스페이스 프로필 편집"
      className="flex flex-col gap-[var(--s-5)]"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave();
      }}
    >
      {/* 아바타 (FR-PS-06) */}
      <section aria-label="워크스페이스 프로필 사진" className="flex items-center gap-[var(--s-4)]">
        <span className="qf-avatar qf-avatar--xl inline-flex items-center justify-center overflow-hidden bg-bg-subtle text-text-muted">
          {profile.avatarUrl ? (
            <img
              src={profile.avatarUrl}
              alt={avatarAlt}
              data-testid="ws-avatar-preview"
              className="h-full w-full object-cover"
            />
          ) : (
            <Icon name="user" size="lg" />
          )}
        </span>
        <div className="flex flex-col gap-[var(--s-2)]">
          <div className="flex gap-[var(--s-2)]">
            <button
              type="button"
              data-testid="ws-avatar-change"
              className="qf-btn qf-btn--secondary qf-btn--sm"
              onClick={onPickAvatar}
              disabled={presign.isPending || finalize.isPending}
              aria-busy={presign.isPending || finalize.isPending}
            >
              {presign.isPending || finalize.isPending ? '업로드 중…' : '아바타 변경'}
            </button>
            {profile.avatarUrl ? (
              <button
                type="button"
                data-testid="ws-avatar-remove"
                // a11y M-1: 접근명 중복 해소.
                aria-label="워크스페이스 아바타 제거"
                className="qf-btn qf-btn--ghost qf-btn--sm"
                onClick={() => void onRemoveAvatar()}
                disabled={removeAvatar.isPending}
                aria-busy={removeAvatar.isPending}
              >
                제거
              </button>
            ) : null}
          </div>
          <p className="text-[length:var(--fs-12)] text-text-muted">PNG·JPG·WEBP, 최대 8MB</p>
          <input
            ref={fileRef}
            type="file"
            accept={WS_MIME_ACCEPT}
            aria-label="워크스페이스 아바타 이미지 파일 선택"
            className="hidden"
            data-testid="ws-avatar-file"
            onChange={(e) => void onAvatarSelected(e)}
          />
        </div>
      </section>

      {/* 닉네임 (FR-PS-06) */}
      <div className="flex flex-col gap-[var(--s-1)]">
        <div className="flex items-center justify-between">
          <label
            htmlFor="ws-nickname"
            className="text-[length:var(--fs-12)] uppercase tracking-[var(--tracking-caps)] text-text-muted"
          >
            닉네임
          </label>
          <span id="ws-nickname-counter" className="text-[length:var(--fs-11)] text-text-muted">
            {nickname.length}/{WS_NICKNAME_MAX}
          </span>
        </div>
        <input
          id="ws-nickname"
          data-testid="ws-nickname"
          className="qf-input"
          value={nickname}
          maxLength={WS_NICKNAME_MAX}
          onChange={(e) => setNickname(e.target.value)}
          placeholder="이 워크스페이스에서 표시할 이름"
          autoComplete="off"
          aria-describedby="ws-nickname-counter"
        />
      </div>

      {/* About Me (FR-PS-06) */}
      <div className="flex flex-col gap-[var(--s-1)]">
        <div className="flex items-center justify-between">
          <label
            htmlFor="ws-bio"
            className="text-[length:var(--fs-12)] uppercase tracking-[var(--tracking-caps)] text-text-muted"
          >
            자기소개
          </label>
          <span id="ws-bio-counter" className="text-[length:var(--fs-11)] text-text-muted">
            {workspaceBio.length}/{WS_BIO_MAX}
          </span>
        </div>
        <textarea
          id="ws-bio"
          data-testid="ws-bio"
          // ui-designer HIGH-1: qf-textarea 단독은 박스 스타일이 없으므로 qf-input 과 병기.
          className="qf-input qf-textarea"
          value={workspaceBio}
          maxLength={WS_BIO_MAX}
          onChange={(e) => setWorkspaceBio(e.target.value)}
          placeholder="이 워크스페이스에서 보일 자기소개 (최대 190자)"
          autoComplete="off"
          aria-describedby="ws-bio-counter"
        />
      </div>

      <div className="flex justify-end">
        <button
          type="submit"
          data-testid="ws-profile-save"
          className="qf-btn qf-btn--primary"
          disabled={saving}
          aria-busy={saving}
        >
          {saving ? '저장 중…' : '저장'}
        </button>
      </div>
    </form>
  );
}
