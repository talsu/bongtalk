import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  HANDLE_RE,
  HANDLE_MAX,
  DISPLAY_NAME_MAX,
  FULL_NAME_MAX,
  PRONOUNS_MAX,
  TITLE_MAX,
  BIO_MAX,
  HANDLE_COOLDOWN_DAYS,
  AVATAR_MAX_BYTES,
  AVATAR_ALLOWED_MIME,
} from '@qufox/shared-types';
import { Icon } from '../../design-system/primitives';
import { useNotifications } from '../../stores/notification-store';
import {
  useMyProfile,
  useUpdateProfile,
  useAvatarPresign,
  useAvatarFinalize,
  useAvatarDelete,
} from '../users/useMyProfile';
import { uploadAvatarBlob } from '../users/avatarUpload';

/**
 * S73 (D14 / FR-PS-01·02·03 + FR-PS-18): 설정 > 프로필 탭(명시적 저장).
 *
 * 전역 신원(handle/displayName/fullName/pronouns/title/timezone/bio)을 한 폼에서
 * 편집한다. handle 은 정규식 실시간 검증 + 쿨다운 중 "다음 변경 가능일 D-N" 상시 표시
 * (handleChangedAt 기반 클라 계산, FR-PS-03). 아바타는 8MB/MIME 클라 검증 + 미리보기
 * 후 presign→PUT→finalize. 저장은 명시적 버튼(FR-PS-18 명시적 저장 탭).
 */
const MIME_ACCEPT = AVATAR_ALLOWED_MIME.join(',');
const DAY_MS = 24 * 60 * 60 * 1000;

/** handleChangedAt 기준 다음 변경 가능 시각 + 남은 일수(D-N). 쿨다운 외면 null. */
export function cooldownInfo(
  handleChangedAt: string | null,
  now: number,
): { nextAt: Date; daysLeft: number } | null {
  if (!handleChangedAt) return null;
  const changed = new Date(handleChangedAt).getTime();
  if (Number.isNaN(changed)) return null;
  const nextAt = new Date(changed + HANDLE_COOLDOWN_DAYS * DAY_MS);
  if (nextAt.getTime() <= now) return null;
  const daysLeft = Math.ceil((nextAt.getTime() - now) / DAY_MS);
  return { nextAt, daysLeft };
}

export function ProfileSettingsPage(): JSX.Element {
  const navigate = useNavigate();
  const notify = useNotifications((s) => s.push);
  const { data: profile, isLoading, isError } = useMyProfile();
  const update = useUpdateProfile();
  const presign = useAvatarPresign();
  const finalize = useAvatarFinalize();
  const removeAvatar = useAvatarDelete();

  const [handle, setHandle] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [fullName, setFullName] = useState('');
  const [pronouns, setPronouns] = useState('');
  const [title, setTitle] = useState('');
  const [timezone, setTimezone] = useState('');
  const [bio, setBio] = useState('');
  const [handleError, setHandleError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!profile) return;
    setHandle(profile.handle ?? '');
    setDisplayName(profile.displayName ?? '');
    setFullName(profile.fullName ?? '');
    setPronouns(profile.pronouns ?? '');
    setTitle(profile.title ?? '');
    setTimezone(profile.timezone ?? '');
    setBio(profile.bio ?? '');
  }, [profile]);

  const cooldown = useMemo(
    () => cooldownInfo(profile?.handleChangedAt ?? null, Date.now()),
    [profile?.handleChangedAt],
  );

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-text-muted">불러오는 중…</div>
    );
  }
  if (isError || !profile) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2">
        <p className="text-text-muted">프로필을 불러올 수 없습니다.</p>
        <button type="button" className="qf-btn qf-btn--ghost" onClick={() => navigate('/')}>
          홈으로
        </button>
      </div>
    );
  }

  const handleChanged = handle !== (profile.handle ?? '');
  // handle 형식 위반은 "실제로 변경하려는" 경우에만 저장을 막는다 — 백필 실패로
  // 기존 handle 이 형식 위반(예: 2자)인 사용자가 다른 필드만 저장하려 할 때 막히지
  // 않게 한다. 변경 중이면 실시간 정규식 에러를 표시한다.
  const handleInvalid = handleChanged && !HANDLE_RE.test(handle);
  // 쿨다운 중이면서 실제로 handle 을 바꾸려는 경우에만 저장을 막는다(동일값은 통과).
  const blockedByCooldown = handleChanged && cooldown !== null;

  const onPickAvatar = (): void => fileRef.current?.click();

  const onAvatarSelected = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    e.target.value = ''; // 같은 파일 재선택 허용.
    if (!file) return;
    if (!(AVATAR_ALLOWED_MIME as readonly string[]).includes(file.type)) {
      notify({
        variant: 'danger',
        title: '지원하지 않는 형식',
        body: 'PNG·JPG·WEBP 만 가능합니다.',
      });
      return;
    }
    if (file.size > AVATAR_MAX_BYTES) {
      notify({
        variant: 'danger',
        title: '파일이 너무 큽니다',
        body: '최대 8MB 까지 업로드할 수 있습니다.',
      });
      return;
    }
    try {
      const { key, putUrl } = await presign.mutateAsync({
        contentType: file.type,
        sizeBytes: file.size,
      });
      await uploadAvatarBlob(putUrl, file);
      await finalize.mutateAsync(key);
      notify({ variant: 'success', title: '아바타를 변경했습니다.' });
    } catch (err) {
      notify({ variant: 'danger', title: '아바타 업로드 실패', body: (err as Error).message });
    }
  };

  const onRemoveAvatar = async (): Promise<void> => {
    try {
      await removeAvatar.mutateAsync();
      notify({ variant: 'success', title: '아바타를 제거했습니다.' });
    } catch (err) {
      notify({ variant: 'danger', title: '아바타 제거 실패', body: (err as Error).message });
    }
  };

  const onSave = async (): Promise<void> => {
    setHandleError(null);
    if (handleInvalid) {
      setHandleError(`핸들은 소문자·숫자·_·. 조합 3–${HANDLE_MAX}자여야 합니다.`);
      return;
    }
    try {
      await update.mutateAsync({
        // handle 은 변경된 경우에만 전송(쿨다운 검증 스킵 + 불필요한 변경 방지).
        ...(handleChanged ? { handle } : {}),
        displayName: displayName.trim().length === 0 ? null : displayName,
        fullName: fullName.trim().length === 0 ? null : fullName,
        pronouns: pronouns.trim().length === 0 ? null : pronouns,
        title: title.trim().length === 0 ? null : title,
        timezone: timezone.trim().length === 0 ? null : timezone,
        bio: bio.trim().length === 0 ? null : bio,
      });
      notify({ variant: 'success', title: '프로필을 저장했습니다.' });
    } catch (err) {
      const e = err as Error & { errorCode?: string; details?: { nextAllowedAt?: string } };
      if (e.errorCode === 'HANDLE_TAKEN') {
        setHandleError('이미 사용 중인 핸들입니다.');
        return;
      }
      if (e.errorCode === 'HANDLE_COOLDOWN_ACTIVE') {
        const nextAt = e.details?.nextAllowedAt ? new Date(e.details.nextAllowedAt) : null;
        setHandleError(
          nextAt
            ? `핸들 변경 쿨다운 중입니다. ${nextAt.toLocaleDateString()} 이후 변경할 수 있습니다.`
            : '핸들 변경 쿨다운 중입니다.',
        );
        return;
      }
      notify({ variant: 'danger', title: '저장 실패', body: e.message });
    }
  };

  const saving = update.isPending;

  return (
    <div
      data-testid="profile-settings-page"
      className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-[var(--s-5)] p-[var(--s-5)]"
    >
      <header className="flex items-center gap-[var(--s-3)]">
        <button
          type="button"
          aria-label="뒤로"
          className="qf-btn qf-btn--ghost qf-btn--icon"
          onClick={() => navigate(-1)}
        >
          <Icon name="chevron-left" size="md" />
        </button>
        <h1 className="text-[length:var(--fs-18)] font-semibold">프로필</h1>
      </header>

      {/* 아바타 (FR-PS-01) */}
      <section className="flex items-center gap-[var(--s-4)]">
        <span className="qf-avatar qf-avatar--xl inline-flex items-center justify-center bg-bg-subtle text-text-muted">
          {profile.avatarUrl ? (
            <img src={profile.avatarUrl} alt="아바타 미리보기" data-testid="avatar-preview" />
          ) : (
            <Icon name="user" size="lg" />
          )}
        </span>
        <div className="flex flex-col gap-[var(--s-2)]">
          <div className="flex gap-[var(--s-2)]">
            <button
              type="button"
              data-testid="avatar-change"
              className="qf-btn qf-btn--secondary qf-btn--sm"
              onClick={onPickAvatar}
              disabled={presign.isPending || finalize.isPending}
            >
              {presign.isPending || finalize.isPending ? '업로드 중…' : '아바타 변경'}
            </button>
            {profile.avatarUrl ? (
              <button
                type="button"
                data-testid="avatar-remove"
                className="qf-btn qf-btn--ghost qf-btn--sm"
                onClick={() => void onRemoveAvatar()}
                disabled={removeAvatar.isPending}
              >
                제거
              </button>
            ) : null}
          </div>
          <p className="text-[length:var(--fs-12)] text-text-muted">PNG·JPG·WEBP, 최대 8MB</p>
          <input
            ref={fileRef}
            type="file"
            accept={MIME_ACCEPT}
            aria-label="아바타 이미지 파일 선택"
            className="hidden"
            data-testid="avatar-file"
            onChange={(e) => void onAvatarSelected(e)}
          />
        </div>
      </section>

      {/* 핸들 (FR-PS-02/03) */}
      <Field label="핸들" htmlFor="pf-handle" counter={`${handle.length}/${HANDLE_MAX}`}>
        <input
          id="pf-handle"
          data-testid="profile-handle"
          className="qf-input"
          value={handle}
          maxLength={HANDLE_MAX}
          onChange={(e) => setHandle(e.target.value)}
          placeholder="lowercase_handle.1"
          aria-invalid={handleInvalid || handleError !== null}
        />
        {handleInvalid ? (
          <p data-testid="handle-regex-error" className="text-[length:var(--fs-12)] text-danger">
            소문자·숫자·_·. 조합 3–{HANDLE_MAX}자만 사용할 수 있습니다.
          </p>
        ) : null}
        {handleError ? (
          <p data-testid="handle-server-error" className="text-[length:var(--fs-12)] text-danger">
            {handleError}
          </p>
        ) : null}
        {cooldown ? (
          <p data-testid="handle-cooldown" className="text-[length:var(--fs-12)] text-text-muted">
            다음 변경 가능일 D-{cooldown.daysLeft} ({cooldown.nextAt.toLocaleDateString()})
          </p>
        ) : null}
      </Field>

      {/* 표시이름 (FR-PS-02) */}
      <Field
        label="표시이름"
        htmlFor="pf-display"
        counter={`${displayName.length}/${DISPLAY_NAME_MAX}`}
      >
        <input
          id="pf-display"
          data-testid="profile-displayName"
          className="qf-input"
          value={displayName}
          maxLength={DISPLAY_NAME_MAX}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="다른 사람에게 보이는 이름"
        />
      </Field>

      {/* 이름 / 대명사 / 제목 (FR-PS-02) */}
      <Field label="이름" htmlFor="pf-full" counter={`${fullName.length}/${FULL_NAME_MAX}`}>
        <input
          id="pf-full"
          data-testid="profile-fullName"
          className="qf-input"
          value={fullName}
          maxLength={FULL_NAME_MAX}
          onChange={(e) => setFullName(e.target.value)}
        />
      </Field>
      <Field label="대명사" htmlFor="pf-pronouns" counter={`${pronouns.length}/${PRONOUNS_MAX}`}>
        <input
          id="pf-pronouns"
          data-testid="profile-pronouns"
          className="qf-input"
          value={pronouns}
          maxLength={PRONOUNS_MAX}
          onChange={(e) => setPronouns(e.target.value)}
          placeholder="예: they/them"
        />
      </Field>
      <Field label="제목" htmlFor="pf-title" counter={`${title.length}/${TITLE_MAX}`}>
        <input
          id="pf-title"
          data-testid="profile-title"
          className="qf-input"
          value={title}
          maxLength={TITLE_MAX}
          onChange={(e) => setTitle(e.target.value)}
        />
      </Field>

      {/* 시간대 (FR-PS-02) */}
      <Field label="시간대 (IANA)" htmlFor="pf-tz">
        <input
          id="pf-tz"
          data-testid="profile-timezone"
          className="qf-input"
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
          placeholder="예: Asia/Seoul"
        />
      </Field>

      {/* About Me (FR-PS-02) */}
      <Field label="자기소개" htmlFor="pf-bio" counter={`${bio.length}/${BIO_MAX}`}>
        <textarea
          id="pf-bio"
          data-testid="profile-bio"
          className="qf-input resize-y"
          style={{ minHeight: 'calc(var(--s-5) * 5)' }}
          value={bio}
          maxLength={BIO_MAX}
          onChange={(e) => setBio(e.target.value)}
          placeholder="자기소개를 입력하세요 (최대 190자)"
        />
      </Field>

      <div className="flex justify-end">
        <button
          type="button"
          data-testid="profile-save"
          className="qf-btn qf-btn--primary"
          onClick={() => void onSave()}
          disabled={saving || handleInvalid || blockedByCooldown}
        >
          {saving ? '저장 중…' : '저장'}
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  htmlFor,
  counter,
  children,
}: {
  label: string;
  htmlFor: string;
  counter?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-[var(--s-1)]">
      <div className="flex items-center justify-between">
        <label
          htmlFor={htmlFor}
          className="text-[length:var(--fs-12)] uppercase tracking-wide text-text-muted"
        >
          {label}
        </label>
        {counter ? (
          <span className="text-[length:var(--fs-11)] text-text-muted">{counter}</span>
        ) : null}
      </div>
      {children}
    </div>
  );
}
