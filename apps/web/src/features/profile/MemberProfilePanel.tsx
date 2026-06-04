import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Avatar, Icon } from '../../design-system/primitives';
import { cn } from '../../lib/cn';
import { useUI } from '../../stores/ui-store';
import { useFullProfile } from './useFullProfile';
import type { FullProfilePresenceStatus, MemberFullProfileView } from '@qufox/shared-types';

/**
 * S75 (D14 / FR-PS-08): 전체 프로필 패널(우측 280px 슬라이드인).
 *
 * 프로필 팝오버의 "전체 프로필" 링크가 ui-store.profilePanelUserId 를 설정하면 셸이 우측
 * 슬롯에 이 패널을 붙인다. 항목: 배너·아바타(80px)·표시이름·@핸들·제목(title)·대명사
 * (pronouns)·시간대+현지시각(IANA tz + Intl.DateTimeFormat 1분 갱신 클록)·About Me(전체)·
 * 역할 목록(시스템 + 커스텀 전부)·커스텀 상태·DM 버튼.
 *
 * 닫기: X / Esc / (다른 팝오버 열기 — setProfilePanelUser(null) 은 팝오버가 호출). 비모달
 * complementary 패널(PinPanel 선례)이라 mount 포커스 이동은 하지 않고, 트리거 복귀는
 * Radix Popover(팝오버 트리거)가 담당한다.
 *
 * 신규 DS 클래스 0 — `.qf-thread-panel`(슬라이드인 골격) + `.qf-hovercard__*` 토큰 + DS
 * 토큰만 사용한다(DS 4파일 무수정).
 */

const STATUS_LABEL: Record<FullProfilePresenceStatus, string> = {
  online: '온라인',
  idle: '자리 비움',
  dnd: '다른 용무 중',
  offline: '오프라인',
};

const PRESENCE_VAR: Record<FullProfilePresenceStatus, string> = {
  online: 'var(--status-online)',
  idle: 'var(--status-idle)',
  dnd: 'var(--status-dnd)',
  offline: 'var(--status-offline)',
};

/**
 * FR-PS-08: IANA tz 의 현지시각을 Intl.DateTimeFormat 으로 포맷한다(1분 갱신은 컴포넌트가
 * setInterval 로 now 를 갱신). 잘못된 tz 는 RangeError → null 폴백(클록 미표시).
 */
function formatZonedClock(timezone: string, now: Date): string | null {
  try {
    return new Intl.DateTimeFormat('ko-KR', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
    }).format(now);
  } catch {
    return null;
  }
}

export function MemberProfilePanel({ workspaceId }: { workspaceId: string }): JSX.Element | null {
  const userId = useUI((s) => s.profilePanelUserId);
  const setProfilePanelUser = useUI((s) => s.setProfilePanelUser);
  const close = useCallback((): void => setProfilePanelUser(null), [setProfilePanelUser]);
  const { data, isLoading } = useFullProfile(workspaceId, userId, !!userId);

  // FR-PS-08: Esc 로 닫는다(PinPanel 선례 · 비모달 complementary). userId 가 있을 때만 바인딩.
  useEffect(() => {
    if (!userId) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') close();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [userId, close]);

  if (!userId) return null;

  return (
    <aside
      id="member-profile-panel"
      aria-label="멤버 프로필"
      data-testid="member-profile-panel"
      // F16 (ui-designer MED · FR-PS-08): `.qf-thread-panel` 은 420px 골격이지만
      // 프로필 패널 명세 폭은 280px. DS 4파일은 수정 금지이므로 앱 레이어에서
      // page-scoped width 로만 좁힌다(DS 토큰/클래스 무수정). flexBasis 까지 좁혀야
      // flex 슬롯에서 실제 280px 로 렌더된다.
      style={{ width: 280, flexBasis: 280 }}
      className="qf-thread-panel"
    >
      {/*
        F8 (a11y H-3): 패널 마운트 시 스크린리더에 1줄 알림. sr-only aria-live
        영역이라 시각 레이아웃에 영향을 주지 않고 콘텐츠 폭주도 없다(고정 문구 1회).
      */}
      <div className="sr-only" role="status" aria-live="polite" data-testid="member-profile-live">
        멤버 프로필 패널이 열렸습니다
      </div>
      <header className="qf-topbar">
        <h2 className="qf-topbar__title flex items-center gap-[var(--s-2)]">멤버 프로필</h2>
        <div className="ml-auto">
          <button
            type="button"
            data-testid="member-profile-close"
            aria-label="프로필 패널 닫기"
            onClick={close}
            className="qf-btn qf-btn--ghost qf-btn--icon qf-btn--sm"
          >
            <Icon name="x" size="sm" />
          </button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading || !data ? (
          <div className="p-[var(--s-4)]" role="status" aria-busy="true">
            <span className="sr-only">프로필 불러오는 중</span>
            <div className="qf-skel h-[var(--s-11)] w-full" aria-hidden="true" />
            <div className="qf-skel mt-[var(--s-4)] h-[var(--s-9)] w-2/3" aria-hidden="true" />
            <div className="qf-skel mt-[var(--s-3)] h-[var(--s-7)] w-full" aria-hidden="true" />
          </div>
        ) : (
          <ProfileBody profile={data} />
        )}
      </div>
    </aside>
  );
}

function ProfileBody({ profile }: { profile: MemberFullProfileView }): JSX.Element {
  const navigate = useNavigate();
  // FR-PS-08: 1분 갱신 현지시각 클록. timezone 이 있을 때만 인터벌을 돈다.
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    if (!profile.timezone) return;
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, [profile.timezone]);
  const localTime = profile.timezone ? formatZonedClock(profile.timezone, now) : null;

  return (
    <div>
      {/* 배너 — 전역 배너 이미지 있으면 그 위에, 없으면 plain. qf-hovercard 토큰 재사용. */}
      {profile.bannerUrl ? (
        <div
          className="qf-hovercard__banner"
          style={{
            backgroundImage: `url(${profile.bannerUrl})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
          }}
          aria-hidden="true"
        />
      ) : (
        <div className="qf-hovercard__banner qf-hovercard__banner--plain" aria-hidden="true" />
      )}
      <div className="px-[var(--s-5)] pb-[var(--s-5)]">
        {/* 아바타 80px(xl). effectiveAvatarUrl(ws > 전역) 우선, 없으면 이니셜. */}
        {profile.effectiveAvatarUrl ? (
          <span className="qf-avatar qf-avatar--xl qf-hovercard__avatar relative inline-flex items-center justify-center overflow-hidden">
            <img
              src={profile.effectiveAvatarUrl}
              alt={`${profile.effectiveDisplayName}의 프로필 사진`}
              className="h-full w-full object-cover"
            />
          </span>
        ) : (
          <span className="qf-hovercard__avatar inline-block">
            <Avatar name={profile.effectiveDisplayName} size="xl" />
          </span>
        )}

        <div className="qf-hovercard__name" data-testid="member-profile-name">
          {profile.effectiveDisplayName}
        </div>
        <div className="qf-hovercard__handle">@{profile.handle}</div>

        {/* 제목 + 대명사. */}
        {profile.title || profile.pronouns ? (
          <div className="mt-[var(--s-2)] text-[length:var(--fs-13)] text-text-secondary">
            {profile.title ? <span data-testid="member-profile-title">{profile.title}</span> : null}
            {profile.title && profile.pronouns ? ' · ' : ''}
            {profile.pronouns ? (
              <span data-testid="member-profile-pronouns">{profile.pronouns}</span>
            ) : null}
          </div>
        ) : null}

        {/* 프레즌스 + 커스텀 상태. */}
        <div className="qf-hovercard__status" data-testid="member-profile-presence">
          <span
            className="qf-hovercard__status-dot"
            style={{ background: PRESENCE_VAR[profile.presenceStatus] }}
            aria-hidden="true"
          />
          <span>{STATUS_LABEL[profile.presenceStatus]}</span>
          {profile.customStatus || profile.customStatusEmoji ? (
            <span className="text-text-secondary" data-testid="member-profile-custom-status">
              {profile.customStatusEmoji ? `${profile.customStatusEmoji} ` : ''}
              {profile.customStatus ?? ''}
            </span>
          ) : null}
        </div>

        {/*
          시간대 + 현지시각(1분 갱신).
          F9 (a11y H-4): 종전엔 현지시각 span 만 aria-label 을 달아 timezone 텍스트와
          현지시각이 분리 낭독되고 "현지 시각" 문구가 중복됐다. 이제 timezone+localTime
          을 단일 wrapper aria-label 로 묶고 내부 span 은 aria-hidden 으로 숨긴다.
        */}
        {profile.timezone ? (
          <div
            className="mt-[var(--s-3)] flex items-center gap-[var(--s-2)] text-[length:var(--fs-13)] text-text-secondary"
            data-testid="member-profile-localtime"
            aria-label={
              localTime
                ? `${profile.timezone} 현지 시각 ${localTime}`
                : `시간대 ${profile.timezone}`
            }
          >
            <Icon name="clock" size="sm" />
            <span aria-hidden="true">{profile.timezone}</span>
            {localTime ? <span aria-hidden="true">· {localTime}</span> : null}
          </div>
        ) : null}

        {/*
          역할 목록(시스템 + 커스텀 전부). systemRole 은 1개 + customRoles 전부 노출.
          F7 (a11y H-2): role="list"/aria-label + 각 뱃지 role="listitem"(DS 클래스 유지).
        */}
        <div
          className="qf-hovercard__roles"
          data-testid="member-profile-roles"
          role="list"
          aria-label="역할"
        >
          <span role="listitem" className="qf-badge qf-badge--accent">
            {profile.systemRole}
          </span>
          {profile.customRoles.map((r) => (
            <span
              key={r.id}
              role="listitem"
              className="qf-badge"
              style={r.color ? { color: r.color, borderColor: r.color } : undefined}
            >
              {r.name}
            </span>
          ))}
        </div>

        {/* About Me 전체(클램프 없음). */}
        {profile.effectiveBio ? (
          <div className="qf-hovercard__about" data-testid="member-profile-about">
            {profile.effectiveBio}
          </div>
        ) : null}

        <div className="mt-[var(--s-4)]">
          <button
            type="button"
            data-testid="member-profile-dm"
            onClick={() => {
              navigate(`/dm/${profile.userId}`);
            }}
            className={cn('qf-btn qf-btn--primary qf-btn--sm w-full')}
          >
            <Icon name="send" size="sm" />
            DM 보내기
          </button>
        </div>
      </div>
    </div>
  );
}
