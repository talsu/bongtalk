import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMyProfile, useUpdateProfile, type ProfileLink } from './useMyProfile';
import { Icon } from '../../design-system/primitives';

/**
 * task-047 iter4 (M3): Discord-parity profile page (read + edit).
 *
 * 데스크톱 + 모바일 동일 컴포넌트 — DS 토큰 기반 responsive layout.
 * route: `/me/profile`.
 *
 * 표시:
 *  - username + email (read-only)
 *  - customStatus (read-only — `/me/profile/status` PATCH 가 별도 surface)
 *  - bio (markdown 허용, 500 chars cap, edit)
 *  - links (cap 3, https?://, edit)
 *
 * 향후 (047 OUT): 다른 사용자의 profile (`/u/:userId`) — workspace 프라이버시
 * 검토 필요.
 */
export function MyProfilePage(): JSX.Element {
  const navigate = useNavigate();
  const { data: profile, isLoading, isError } = useMyProfile();
  const update = useUpdateProfile();

  const [bio, setBio] = useState('');
  const [links, setLinks] = useState<ProfileLink[]>([]);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (profile) {
      setBio(profile.bio ?? '');
      setLinks(profile.links ?? []);
    }
  }, [profile]);

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

  const onSave = async (): Promise<void> => {
    try {
      await update.mutateAsync({
        bio: bio.trim().length === 0 ? null : bio,
        links: links.length === 0 ? null : links,
      });
      setEditing(false);
    } catch {
      // 에러는 toast / banner 통해 노출 — error-messages.ts (047 P framework) 후속 wire
    }
  };

  const onCancel = (): void => {
    setBio(profile.bio ?? '');
    setLinks(profile.links ?? []);
    setEditing(false);
  };

  return (
    <div
      data-testid="me-profile-page"
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
        <h1 className="text-[length:var(--fs-18)] font-semibold">내 프로필</h1>
      </header>

      <section className="flex flex-col gap-[var(--s-2)]">
        <h2 className="text-[length:var(--fs-12)] uppercase tracking-wide text-text-muted">계정</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-[var(--s-4)] gap-y-[var(--s-1)] text-[length:var(--fs-14)]">
          <dt className="text-text-muted">사용자명</dt>
          <dd>{profile.username}</dd>
          <dt className="text-text-muted">이메일</dt>
          <dd>{profile.email}</dd>
          <dt className="text-text-muted">상태 메시지</dt>
          <dd>{profile.customStatus ?? <span className="text-text-muted">설정 안 됨</span>}</dd>
        </dl>
      </section>

      <section className="flex flex-col gap-[var(--s-2)]">
        <div className="flex items-center justify-between">
          <h2 className="text-[length:var(--fs-12)] uppercase tracking-wide text-text-muted">
            자기소개
          </h2>
          {!editing ? (
            <button
              type="button"
              data-testid="profile-edit"
              className="qf-btn qf-btn--ghost qf-btn--sm"
              onClick={() => setEditing(true)}
            >
              편집
            </button>
          ) : null}
        </div>
        {editing ? (
          <textarea
            data-testid="profile-bio-input"
            aria-label="자기소개"
            className="qf-input resize-y"
            style={{ minHeight: 'calc(var(--s-5) * 6)' }}
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            placeholder="자기소개를 입력하세요 (markdown 허용, 최대 500자)"
            maxLength={500}
          />
        ) : (
          <p className="whitespace-pre-wrap break-words text-[length:var(--fs-14)]">
            {profile.bio ?? <span className="text-text-muted">자기소개가 없습니다.</span>}
          </p>
        )}
      </section>

      <section className="flex flex-col gap-[var(--s-2)]">
        <h2 className="text-[length:var(--fs-12)] uppercase tracking-wide text-text-muted">링크</h2>
        {editing ? (
          <LinksEditor links={links} onChange={setLinks} />
        ) : profile.links && profile.links.length > 0 ? (
          <ul className="flex flex-col gap-[var(--s-1)]">
            {profile.links.map((l, i) => (
              <li key={`${l.url}-${i}`}>
                <a
                  href={l.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-link underline"
                >
                  {l.label ?? l.url}
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-text-muted">링크가 없습니다.</span>
        )}
      </section>

      {editing ? (
        <div className="flex justify-end gap-[var(--s-2)]">
          <button
            type="button"
            data-testid="profile-cancel"
            className="qf-btn qf-btn--ghost"
            onClick={onCancel}
            disabled={update.isPending}
          >
            취소
          </button>
          <button
            type="button"
            data-testid="profile-save"
            className="qf-btn qf-btn--primary"
            onClick={() => void onSave()}
            disabled={update.isPending}
          >
            {update.isPending ? '저장 중…' : '저장'}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function LinksEditor({
  links,
  onChange,
}: {
  links: ProfileLink[];
  onChange: (next: ProfileLink[]) => void;
}): JSX.Element {
  const canAdd = links.length < 3;
  return (
    <div className="flex flex-col gap-[var(--s-2)]" data-testid="profile-links-editor">
      {links.map((l, i) => (
        <div key={i} className="flex gap-[var(--s-2)]">
          <input
            type="url"
            aria-label={`링크 ${i + 1} URL`}
            value={l.url}
            onChange={(e) => {
              const next = [...links];
              next[i] = { ...next[i], url: e.target.value };
              onChange(next);
            }}
            placeholder="https://example.com"
            className="qf-input flex-1"
          />
          <input
            type="text"
            aria-label={`링크 ${i + 1} 라벨`}
            value={l.label ?? ''}
            onChange={(e) => {
              const next = [...links];
              next[i] = { ...next[i], label: e.target.value };
              onChange(next);
            }}
            placeholder="라벨 (선택)"
            maxLength={32}
            className="qf-input flex-1"
          />
          <button
            type="button"
            aria-label="링크 삭제"
            className="qf-btn qf-btn--ghost qf-btn--icon"
            onClick={() => onChange(links.filter((_, j) => j !== i))}
          >
            <Icon name="x" size="md" />
          </button>
        </div>
      ))}
      {canAdd ? (
        <button
          type="button"
          data-testid="profile-add-link"
          className="qf-btn qf-btn--ghost qf-btn--sm self-start"
          onClick={() => onChange([...links, { url: 'https://' }])}
        >
          + 링크 추가
        </button>
      ) : null}
    </div>
  );
}
