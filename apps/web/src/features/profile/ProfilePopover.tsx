import * as RPopover from '@radix-ui/react-popover';
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Avatar, Icon } from '../../design-system/primitives';
import { cn } from '../../lib/cn';
import { useUI } from '../../stores/ui-store';
import { useFullProfile } from './useFullProfile';
import type { FullProfilePresenceStatus } from '@qufox/shared-types';

/**
 * S75 (D14 / FR-PS-07): 프로필 팝오버(Hovercard) 미니카드.
 *
 * 메시지 아바타/작성자명·멤버 행을 트리거로 클릭/Enter/Space 시 DS `.qf-hovercard`
 * 미니카드를 띄운다. 항목: ws아바타(80px)·표시이름(effectiveDisplayName)·@핸들·역할
 * 뱃지(≤3 + 더보기)·About Me(2줄 클램프)·커스텀 상태(텍스트+이모지)·프레즌스 dot+상태·
 * "DM 보내기"(첫 포커스)·"전체 프로필" 링크(MemberProfilePanel 을 연다).
 *
 * a11y: 트리거 role=button aria-haspopup=dialog, 팝오버 role=dialog(Radix Content 기본).
 * Esc·외부클릭 닫힘 + 포커스 트리거 복원은 Radix Popover 가 처리한다. 터치는 tap 단일 진입점
 * (Radix Trigger 가 click 으로 토글 — 별도 hover 진입점 없음 · FR-PS-07 터치 요구사항).
 *
 * 신규 DS 클래스 0 — `.qf-hovercard` 골격 + DS 토큰만 사용한다(DS 4파일 무수정).
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

/** 역할 뱃지 최대 노출 수(초과분은 "+N" 더보기 뱃지). */
const MAX_ROLE_BADGES = 3;

export function ProfilePopover({
  userId,
  workspaceId,
  children,
}: {
  userId: string;
  workspaceId: string;
  /** 트리거 — 아바타/작성자명/멤버 행. Radix Trigger 가 asChild 로 button 의미를 입힌다. */
  children: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  // 팝오버가 열려 있을 때만 full-profile 을 fetch 한다(목록의 모든 행을 미리 불러오지 않음).
  const { data, isLoading } = useFullProfile(workspaceId, userId, open);
  const setProfilePanelUser = useUI((s) => s.setProfilePanelUser);
  // "DM 보내기" — /dm/:userId 로 이동(DmShell 이 1:1 DM 채널을 resolve/생성). 기존 멤버
  // 디렉터리/친구 목록의 DM 진입과 동일한 단일 경로라 prop-drilling 없이 일관 동작한다.
  const navigate = useNavigate();

  return (
    <RPopover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // FR-PS-08: 다른 팝오버를 열면 열려 있던 전체 프로필 패널을 닫는다(상호배타).
        if (next) setProfilePanelUser(null);
      }}
    >
      <RPopover.Trigger asChild>
        {/*
          트리거는 호출측이 넘긴 단일 엘리먼트(아바타/이름/행). Radix 가 asChild 로
          role=button + aria-haspopup=dialog + aria-expanded 를 주입한다.
        */}
        <span
          role="button"
          tabIndex={0}
          aria-haspopup="dialog"
          data-testid={`profile-trigger-${userId}`}
          className="cursor-pointer outline-none"
        >
          {children}
        </span>
      </RPopover.Trigger>
      <RPopover.Portal>
        <RPopover.Content
          align="start"
          side="right"
          sideOffset={8}
          collisionPadding={8}
          aria-label="프로필 미리보기"
          data-testid={`profile-popover-${userId}`}
          // DS 미니카드 골격 + overlay z-index. role=dialog 는 Radix Content 가 부여.
          className="qf-hovercard z-overlay"
        >
          {isLoading || !data ? (
            <div className="qf-hovercard__body" role="status" aria-busy="true">
              <span className="sr-only">프로필 불러오는 중</span>
              <div className="qf-skel mt-[var(--s-5)] h-[var(--s-9)] w-full" aria-hidden="true" />
              <div className="qf-skel mt-[var(--s-3)] h-[var(--s-7)] w-2/3" aria-hidden="true" />
            </div>
          ) : (
            <>
              {/* 배너(전역 배너 이미지 있으면 그 위에, 없으면 plain). */}
              {data.bannerUrl ? (
                <div
                  className="qf-hovercard__banner"
                  style={{
                    backgroundImage: `url(${data.bannerUrl})`,
                    backgroundSize: 'cover',
                    backgroundPosition: 'center',
                  }}
                  aria-hidden="true"
                />
              ) : (
                <div
                  className="qf-hovercard__banner qf-hovercard__banner--plain"
                  aria-hidden="true"
                />
              )}
              <div className="qf-hovercard__body">
                {/* 아바타 80px(xl) — effectiveAvatarUrl(ws > 전역). 없으면 이니셜. */}
                {data.effectiveAvatarUrl ? (
                  <span className="qf-avatar qf-avatar--xl qf-hovercard__avatar relative inline-flex items-center justify-center overflow-hidden">
                    <img
                      src={data.effectiveAvatarUrl}
                      alt={`${data.effectiveDisplayName}의 프로필 사진`}
                      className="h-full w-full object-cover"
                    />
                  </span>
                ) : (
                  <span className="qf-hovercard__avatar inline-block">
                    <Avatar name={data.effectiveDisplayName} size="xl" />
                  </span>
                )}
                <div className="qf-hovercard__name" data-testid={`profile-name-${userId}`}>
                  {data.effectiveDisplayName}
                </div>
                <div className="qf-hovercard__handle">@{data.handle}</div>

                {/* 프레즌스 dot + 상태 + (있으면) 커스텀 상태. */}
                <div className="qf-hovercard__status" data-testid={`profile-presence-${userId}`}>
                  <span
                    className="qf-hovercard__status-dot"
                    style={{ background: PRESENCE_VAR[data.presenceStatus] }}
                    aria-hidden="true"
                  />
                  <span>{STATUS_LABEL[data.presenceStatus]}</span>
                  {data.customStatus || data.customStatusEmoji ? (
                    <span
                      className="text-text-secondary"
                      data-testid={`profile-custom-status-${userId}`}
                    >
                      {data.customStatusEmoji ? `${data.customStatusEmoji} ` : ''}
                      {data.customStatus ?? ''}
                    </span>
                  ) : null}
                </div>

                {/* 역할 뱃지 ≤3 + 초과분 "+N" 더보기. */}
                {data.customRoles.length > 0 ? (
                  <div className="qf-hovercard__roles" data-testid={`profile-roles-${userId}`}>
                    {data.customRoles.slice(0, MAX_ROLE_BADGES).map((r) => (
                      <span
                        key={r.id}
                        className="qf-badge"
                        style={r.color ? { color: r.color, borderColor: r.color } : undefined}
                      >
                        {r.name}
                      </span>
                    ))}
                    {data.customRoles.length > MAX_ROLE_BADGES ? (
                      <span className="qf-badge" data-testid={`profile-roles-more-${userId}`}>
                        +{data.customRoles.length - MAX_ROLE_BADGES}
                      </span>
                    ) : null}
                  </div>
                ) : null}

                {/* About Me 2줄 클램프(effectiveBio = workspaceBio > bio). */}
                {data.effectiveBio ? (
                  <div
                    className="qf-hovercard__about line-clamp-2"
                    data-testid={`profile-about-${userId}`}
                  >
                    {data.effectiveBio}
                  </div>
                ) : null}

                <div className="qf-hovercard__actions flex flex-col gap-[var(--s-2)]">
                  {/* "DM 보내기" — 첫 포커스(autoFocus). */}
                  <button
                    type="button"
                    autoFocus
                    data-testid={`profile-dm-${userId}`}
                    onClick={() => {
                      setOpen(false);
                      navigate(`/dm/${userId}`);
                    }}
                    className="qf-btn qf-btn--primary qf-btn--sm"
                  >
                    <Icon name="send" size="sm" />
                    DM 보내기
                  </button>
                  {/* "전체 프로필" — 우측 슬라이드인 패널을 연다(팝오버는 닫는다). */}
                  <button
                    type="button"
                    data-testid={`profile-open-panel-${userId}`}
                    onClick={() => {
                      setOpen(false);
                      setProfilePanelUser(userId);
                    }}
                    className={cn('qf-btn qf-btn--ghost qf-btn--sm')}
                  >
                    전체 프로필
                  </button>
                </div>
              </div>
            </>
          )}
        </RPopover.Content>
      </RPopover.Portal>
    </RPopover.Root>
  );
}
