import {
  cloneElement,
  isValidElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import { Link, useNavigate } from 'react-router-dom';
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
  BANNER_MAX_BYTES,
  BANNER_ALLOWED_MIME,
  BANNER_MIN_WIDTH,
  BANNER_MIN_HEIGHT,
  type UpdateProfileInput,
} from '@qufox/shared-types';
import { Icon } from '../../design-system/primitives';
import { useNotifications } from '../../stores/notification-store';
import {
  useMyProfile,
  useUpdateProfile,
  useAvatarPresign,
  useAvatarFinalize,
  useAvatarDelete,
  useBannerPresign,
  useBannerFinalize,
  useBannerDelete,
} from '../users/useMyProfile';
import { useCustomStatus, useSetCustomStatus } from '../presence/useCustomStatus';
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
const BANNER_MIME_ACCEPT = BANNER_ALLOWED_MIME.join(',');
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
  // S74 (FR-PS-04): 배너.
  const bannerPresign = useBannerPresign();
  const bannerFinalize = useBannerFinalize();
  const removeBanner = useBannerDelete();
  // S74 (FR-PS-05): 커스텀 상태 DND 옵션.
  const { data: statusView } = useCustomStatus();
  const setStatus = useSetCustomStatus();

  const [handle, setHandle] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [fullName, setFullName] = useState('');
  const [pronouns, setPronouns] = useState('');
  const [title, setTitle] = useState('');
  const [timezone, setTimezone] = useState('');
  const [bio, setBio] = useState('');
  const [handleError, setHandleError] = useState<string | null>(null);
  // a11y M-2: DND 토글 실패 메시지(sr-only role=alert 로 통지).
  const [dndError, setDndError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const bannerRef = useRef<HTMLInputElement | null>(null);

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
      <div role="status" className="flex h-full items-center justify-center text-text-muted">
        불러오는 중…
      </div>
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
      const { key, url, fields } = await presign.mutateAsync({
        contentType: file.type,
        sizeBytes: file.size,
      });
      // security HIGH#2: presigned POST multipart 업로드(MinIO 가 크기/MIME 정책 강제).
      await uploadAvatarBlob(url, fields, file);
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

  // S74 (FR-PS-04): 배너 선택 → MIME/크기 클라 검증 → presign → POST → finalize.
  const onPickBanner = (): void => bannerRef.current?.click();

  const onBannerSelected = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!(BANNER_ALLOWED_MIME as readonly string[]).includes(file.type)) {
      notify({
        variant: 'danger',
        title: '지원하지 않는 형식',
        body: 'PNG·JPG·WEBP 만 가능합니다.',
      });
      return;
    }
    if (file.size > BANNER_MAX_BYTES) {
      notify({
        variant: 'danger',
        title: '파일이 너무 큽니다',
        body: '최대 8MB 까지 업로드할 수 있습니다.',
      });
      return;
    }
    try {
      const { key, url, fields } = await bannerPresign.mutateAsync({
        contentType: file.type,
        sizeBytes: file.size,
      });
      await uploadAvatarBlob(url, fields, file);
      await bannerFinalize.mutateAsync(key);
      notify({ variant: 'success', title: '배너를 변경했습니다.' });
    } catch (err) {
      notify({ variant: 'danger', title: '배너 업로드 실패', body: (err as Error).message });
    }
  };

  const onRemoveBanner = async (): Promise<void> => {
    try {
      await removeBanner.mutateAsync();
      notify({ variant: 'success', title: '배너를 제거했습니다.' });
    } catch (err) {
      notify({ variant: 'danger', title: '배너 제거 실패', body: (err as Error).message });
    }
  };

  // S74 (FR-PS-05): DND 동시 활성화 옵션 토글(커스텀 상태 set 의 dndDuringStatus).
  // reviewer HIGH-1: text 를 보내지 않아도 서버가 활성 커스텀 상태를 보존한다(조건부 갱신).
  const onToggleDnd = async (next: boolean): Promise<void> => {
    setDndError(null);
    try {
      await setStatus.mutateAsync({ dndDuringStatus: next });
      notify({
        variant: 'success',
        title: next ? '상태 만료 시 DND 활성화를 켰습니다.' : '상태 만료 시 DND 활성화를 껐습니다.',
      });
    } catch (err) {
      const msg = (err as Error).message;
      setDndError(`설정 저장 실패: ${msg}`);
      notify({ variant: 'danger', title: '설정 저장 실패', body: msg });
    }
  };

  const onSave = async (): Promise<void> => {
    setHandleError(null);
    if (handleInvalid) {
      setHandleError(`핸들은 소문자·숫자·_·. 조합 3–${HANDLE_MAX}자여야 합니다.`);
      return;
    }
    // contract LOW: 서버 normString(trim 후 빈 문자열→null)과 WYSIWYG 가 일치하도록 클라에서
    // 먼저 trim 한 뒤 전송한다. reviewer LOW(bio 회귀): 변경된 필드만 PATCH 에 싣는다 —
    // 기존 ≥191자 bio 유저가 bio 를 만지지 않고 다른 필드만 저장할 때 길이 검증에 걸리지
    // 않게 한다(서버는 patch 에 없는 필드를 검증·갱신하지 않음).
    const norm = (raw: string): string | null => {
      const t = raw.trim();
      return t.length === 0 ? null : t;
    };
    const patch: UpdateProfileInput = {};
    // handle 은 변경된 경우에만 전송(쿨다운 검증 스킵 + 불필요한 변경 방지).
    if (handleChanged) patch.handle = handle.trim();
    const fieldOf = (
      cur: string,
      original: string | null,
    ): { changed: boolean; value: string | null } => {
      const value = norm(cur);
      return { changed: value !== (original ?? null), value };
    };
    for (const [key, cur, original] of [
      ['displayName', displayName, profile.displayName],
      ['fullName', fullName, profile.fullName],
      ['pronouns', pronouns, profile.pronouns],
      ['title', title, profile.title],
      ['timezone', timezone, profile.timezone],
      ['bio', bio, profile.bio],
    ] as const) {
      const { changed, value } = fieldOf(cur, original);
      if (changed) patch[key] = value;
    }
    try {
      await update.mutateAsync(patch);
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
  // S74 (FR-PS-05): 토글 현재값 — 상태 뷰가 로드됐으면 그 값을, 아니면 프로필 폴백.
  const dndDuringStatus = statusView?.dndDuringStatus ?? profile.dndDuringStatus;

  // a11y SERIOUS-1/2 + MODERATE-2: handle input 의 aria-describedby 는 활성화된
  // 보조 텍스트(정규식 에러 → 서버 에러 → 쿨다운 힌트) id 들을 묶는다.
  const handleDescribedBy =
    [
      handleInvalid ? 'pf-handle-regex' : null,
      handleError ? 'pf-handle-server' : null,
      cooldown ? 'pf-handle-cooldown' : null,
      'pf-handle-counter',
    ]
      .filter(Boolean)
      .join(' ') || undefined;

  return (
    // F-M3: bare 콘텐츠 — 프레임은 SettingsShell 의 qf-settings__main 이 제공한다.
    // min-h-screen/외곽패딩/뒤로가기 버튼을 제거(이중 스크롤/패딩·셸 내 중복 chrome 해소).
    // 자체 h1 은 유지한다. (모바일은 SettingsShell 이 자식 Outlet 만 전체화면 렌더 — F-B4.)
    <form
      data-testid="profile-settings-page"
      className="mx-auto flex w-full max-w-2xl flex-col gap-[var(--s-5)]"
      onSubmit={(e) => {
        // a11y MODERATE-4: Enter 제출 — 저장 버튼은 type=submit.
        e.preventDefault();
        void onSave();
      }}
    >
      <header className="flex items-center gap-[var(--s-3)]">
        <h1 className="text-[length:var(--fs-18)] font-semibold">프로필</h1>
        {/*
          S75 fix-forward (F15 / FR-PS-14 도달성): 차단 목록(/settings/privacy)이
          종전엔 URL 직접입력으로만 도달했다. 가장 인접한 설정 페이지(프로필)에서
          "프라이버시 & 안전" 링크로 진입점을 제공한다.
        */}
        <Link
          to="/settings/privacy"
          data-testid="profile-to-privacy-link"
          className="qf-btn qf-btn--ghost qf-btn--sm ml-auto"
        >
          프라이버시 & 안전
        </Link>
      </header>

      {/* 아바타 (FR-PS-01) — a11y MODERATE-3: section aria-label */}
      <section aria-label="프로필 사진" className="flex items-center gap-[var(--s-4)]">
        <span className="qf-avatar qf-avatar--xl inline-flex items-center justify-center bg-bg-subtle text-text-muted">
          {profile.avatarUrl ? (
            <img
              src={profile.avatarUrl}
              alt={`${profile.displayName ?? profile.handle ?? profile.username}의 프로필 사진`}
              data-testid="avatar-preview"
            />
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
              aria-busy={presign.isPending || finalize.isPending}
            >
              {presign.isPending || finalize.isPending ? '업로드 중…' : '아바타 변경'}
            </button>
            {profile.avatarUrl ? (
              <button
                type="button"
                data-testid="avatar-remove"
                // a11y M-1: "제거" 텍스트만으로는 접근명이 배너 제거와 중복 → aria-label 로 구분.
                aria-label="아바타 제거"
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
            accept={MIME_ACCEPT}
            aria-label="아바타 이미지 파일 선택"
            className="hidden"
            data-testid="avatar-file"
            onChange={(e) => void onAvatarSelected(e)}
          />
        </div>
      </section>

      {/* 배너 (FR-PS-04) */}
      <section aria-label="프로필 배너" className="flex flex-col gap-[var(--s-2)]">
        <span className="text-[length:var(--fs-12)] uppercase tracking-[var(--tracking-caps)] text-text-muted">
          배너
        </span>
        {/* a11y BLOCKER-1: 미리보기 div(role 없음)에 aria-busy 만 두면 SR 이 업로드중을
            읽지 못한다 → sr-only role=status live region 으로 업로드 상태를 전달한다. */}
        <p className="sr-only" role="status" aria-live="polite">
          {bannerPresign.isPending || bannerFinalize.isPending ? '배너 업로드 중' : ''}
        </p>
        <div
          data-testid="banner-preview"
          className="flex aspect-[17/6] w-full items-center justify-center overflow-hidden rounded-[var(--r-md)] bg-bg-subtle text-text-muted"
        >
          {profile.bannerUrl ? (
            <img
              src={profile.bannerUrl}
              alt="프로필 배너"
              data-testid="banner-image"
              className="h-full w-full object-cover"
            />
          ) : (
            <Icon name="image" size="lg" />
          )}
        </div>
        <div className="flex items-center gap-[var(--s-2)]">
          <button
            type="button"
            data-testid="banner-change"
            className="qf-btn qf-btn--secondary qf-btn--sm"
            onClick={onPickBanner}
            disabled={bannerPresign.isPending || bannerFinalize.isPending}
            aria-busy={bannerPresign.isPending || bannerFinalize.isPending}
          >
            {bannerPresign.isPending || bannerFinalize.isPending ? '업로드 중…' : '배너 변경'}
          </button>
          {profile.bannerUrl ? (
            <button
              type="button"
              data-testid="banner-remove"
              // a11y M-1: "제거" 텍스트만으로는 접근명이 아바타 제거와 중복 → aria-label 로 구분.
              aria-label="배너 제거"
              className="qf-btn qf-btn--ghost qf-btn--sm"
              onClick={() => void onRemoveBanner()}
              disabled={removeBanner.isPending}
              aria-busy={removeBanner.isPending}
            >
              제거
            </button>
          ) : null}
        </div>
        <p className="text-[length:var(--fs-12)] text-text-muted">
          PNG·JPG·WEBP, 최대 8MB, 권장 {BANNER_MIN_WIDTH}×{BANNER_MIN_HEIGHT}px 이상
        </p>
        <input
          ref={bannerRef}
          type="file"
          accept={BANNER_MIME_ACCEPT}
          aria-label="배너 이미지 파일 선택"
          className="hidden"
          data-testid="banner-file"
          onChange={(e) => void onBannerSelected(e)}
        />
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
          autoComplete="off"
          // a11y MODERATE-2: 쿨다운으로 막힌 상태도 invalid 로 표시.
          aria-invalid={handleInvalid || handleError !== null || blockedByCooldown}
          aria-describedby={handleDescribedBy}
        />
        {handleInvalid ? (
          // a11y BLOCKER-1: --danger-600 (라이트 4.64:1 통과). SERIOUS-1: aria-live=polite.
          <p
            id="pf-handle-regex"
            data-testid="handle-regex-error"
            aria-live="polite"
            className="text-[length:var(--fs-12)] text-[color:var(--danger-600)]"
          >
            소문자·숫자·_·. 조합 3–{HANDLE_MAX}자만 사용할 수 있습니다.
          </p>
        ) : null}
        {handleError ? (
          // SERIOUS-1: 서버 에러는 role=alert(즉시 통지).
          <p
            id="pf-handle-server"
            data-testid="handle-server-error"
            role="alert"
            className="text-[length:var(--fs-12)] text-[color:var(--danger-600)]"
          >
            {handleError}
          </p>
        ) : null}
        {cooldown ? (
          // a11y SERIOUS-2: 쿨다운 힌트 role=status + aria-atomic.
          <p
            id="pf-handle-cooldown"
            data-testid="handle-cooldown"
            role="status"
            aria-atomic="true"
            className="text-[length:var(--fs-12)] text-text-muted"
          >
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
          autoComplete="nickname"
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
          autoComplete="name"
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
          autoComplete="off"
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
          autoComplete="off"
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
          autoComplete="off"
        />
      </Field>

      {/* About Me (FR-PS-02) — ui-designer HIGH-1: qf-textarea 단독은 border/bg/radius 가
          없으므로(qf-input 별개) qf-input 과 병기해 박스 스타일을 받는다. */}
      <Field label="자기소개" htmlFor="pf-bio" counter={`${bio.length}/${BIO_MAX}`}>
        <textarea
          id="pf-bio"
          data-testid="profile-bio"
          className="qf-input qf-textarea"
          value={bio}
          maxLength={BIO_MAX}
          onChange={(e) => setBio(e.target.value)}
          placeholder="자기소개를 입력하세요 (최대 190자)"
          autoComplete="off"
        />
      </Field>

      {/* 커스텀 상태 — DND 동시 활성화 옵션 (FR-PS-05) */}
      <section aria-label="커스텀 상태" className="flex flex-col gap-[var(--s-2)]">
        <span className="text-[length:var(--fs-12)] uppercase tracking-[var(--tracking-caps)] text-text-muted">
          커스텀 상태
        </span>
        {/* a11y HIGH-1 + ui-designer MEDIUM-2: checkbox → role=switch 버튼 + DS .qf-toggle-row/
            .qf-switch 패턴. onToggleDnd 는 서버측 상태 보존(HIGH-1 fix)에 의존하므로 text 를
            보내지 않아도 활성 커스텀 상태가 삭제되지 않는다. */}
        <div className="qf-toggle-row" style={{ borderBottom: 'none', padding: 0 }}>
          <div className="qf-toggle-row__text">
            <div className="qf-toggle-row__title" id="pf-dnd-label">
              상태 만료 시 방해 금지(DND) 활성화
            </div>
            <div className="qf-toggle-row__desc">
              상태 메시지가 만료되면 자동으로 방해 금지(DND)로 전환합니다.
            </div>
          </div>
          <button
            type="button"
            role="switch"
            data-testid="dnd-during-status"
            className="qf-switch"
            aria-checked={dndDuringStatus}
            aria-labelledby="pf-dnd-label"
            aria-busy={setStatus.isPending}
            disabled={setStatus.isPending}
            onClick={() => void onToggleDnd(!dndDuringStatus)}
          />
        </div>
        {/* a11y M-2: DND 토글 실패는 sr-only role=alert live region 으로 즉시 통지. */}
        {dndError ? (
          <p data-testid="dnd-error" role="alert" className="sr-only">
            {dndError}
          </p>
        ) : null}
      </section>

      <div className="flex justify-end">
        <button
          type="submit"
          data-testid="profile-save"
          className="qf-btn qf-btn--primary"
          disabled={saving || handleInvalid || blockedByCooldown}
          aria-busy={saving}
        >
          {saving ? '저장 중…' : '저장'}
        </button>
      </div>
    </form>
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
  // a11y MODERATE-1: counter span 에 id 를 부여하고, 단일 자식 input/textarea 의
  // aria-describedby 에 자동 연결한다(이미 describedby 가 있으면 보존·병합).
  const counterId = counter ? `${htmlFor}-counter` : undefined;
  const described = (() => {
    if (!counterId || !isValidElement(children)) return children;
    const childProps = children.props as { 'aria-describedby'?: string };
    const existing = childProps['aria-describedby'];
    // handle 처럼 자식이 직접 describedby 를 지정한 경우 counter id 가 이미 포함돼 있으면
    // 중복 추가하지 않는다.
    if (existing && existing.split(' ').includes(counterId)) return children;
    const merged = existing ? `${existing} ${counterId}` : counterId;
    return cloneElement(children as ReactElement, { 'aria-describedby': merged });
  })();
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
          <span id={counterId} className="text-[length:var(--fs-11)] text-text-muted">
            {counter}
          </span>
        ) : null}
      </div>
      {described}
    </div>
  );
}
