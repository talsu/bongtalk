import * as RPopover from '@radix-ui/react-popover';
import { forwardRef, useState, type ReactNode } from 'react';
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
 *
 * S75 fix-forward (a11y F3 B-2/B-3/M-4): 종전엔 호출측 children 을 별도
 * `<span role="button" tabIndex=0 …>` 으로 감싸 Radix `asChild` 가 동일 ARIA 를
 * 또 주입(중복)했고, `<span>`(inline) 안에 block `<div class="qf-member">` 를 넣어
 * block-in-inline HTML 위반이 났으며, `outline-none` 이 DS `:focus-visible` 링을
 * 제거했다. 이제 단일 host 요소를 forwardRef 로 만들어 Radix Trigger 가 그 요소에
 * **직접** role/aria/focus 핸들러를 주입하도록 위임한다(중복 제거). host 태그는
 * `as`('span'|'div')로 호출측이 고른다 — 인라인(아바타·작성자명)은 span, 블록(멤버
 * 행)은 div 로 렌더해 block-in-inline 을 피한다. 포커스 표시는 outline-none 을 빼고
 * DS `:focus-visible` 에 위임한다.
 */

/**
 * 팝오버 트리거의 단일 host 요소(forwardRef). Radix `<Trigger asChild>` 가 이
 * 요소에 role/aria-haspopup/aria-expanded/onClick/onKeyDown/ref 를 직접 주입한다.
 * 비-button host(span/div)는 Radix 가 role/tabIndex 를 자동 부여하지 않으므로
 * 여기서 role="button" + tabIndex=0 을 명시한다(키보드 진입점). outline-none 은
 * 두지 않아 DS `:focus-visible` 포커스 링이 살아 있다.
 */
type TriggerHostProps = {
  as?: 'span' | 'div';
  testId: string;
  className?: string;
  children: ReactNode;
} & React.HTMLAttributes<HTMLElement>;

const TriggerHost = forwardRef<HTMLElement, TriggerHostProps>(function TriggerHost(
  { as = 'span', testId, className, children, ...rest },
  ref,
) {
  const Tag = as as 'span';
  return (
    <Tag
      ref={ref as React.Ref<HTMLSpanElement>}
      role="button"
      tabIndex={0}
      data-testid={testId}
      className={cn('cursor-pointer', className)}
      {...rest}
    >
      {children}
    </Tag>
  );
});

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
  as = 'span',
  triggerClassName,
  triggerProps,
  children,
}: {
  userId: string;
  workspaceId: string;
  /**
   * 트리거 host 태그. 인라인 트리거(아바타·작성자명)는 'span', 블록 트리거(멤버
   * 행 div)는 'div' 로 호출측이 지정해 block-in-inline 위반을 피한다(F3 B-3).
   */
  as?: 'span' | 'div';
  /** 트리거 host 에 얹을 추가 className(레이아웃 유지용 — 예: flex/min-w-0). */
  triggerClassName?: string;
  /**
   * 트리거 host 에 덮어쓸 추가 속성. F5(a11y M-1): 메시지 행의 아바타 트리거를
   * `tabIndex=-1`+`aria-hidden` 으로 키보드 진입에서 제외해(마우스 전용), 작성자명을
   * 단일 키보드 진입점으로 만들 때 쓴다(중복 포커스 스톱 제거).
   */
  triggerProps?: React.HTMLAttributes<HTMLElement>;
  /** 트리거 내용 — 아바타/작성자명/멤버 행. TriggerHost 가 role/aria/focus 를 부여한다. */
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
          F3: Radix 가 이 단일 host 요소에 직접 role/aria-haspopup/aria-expanded/
          onClick/onKeyDown/ref 를 주입한다(별도 wrapper span 제거 — ARIA 중복 없음).
          host 태그는 as 로 결정해 block-in-inline 을 피한다.
        */}
        <TriggerHost
          as={as}
          testId={`profile-trigger-${userId}`}
          className={triggerClassName}
          {...triggerProps}
        >
          {children}
        </TriggerHost>
      </RPopover.Trigger>
      <RPopover.Portal>
        <RPopover.Content
          align="start"
          side="right"
          sideOffset={8}
          collisionPadding={8}
          aria-label="프로필 미리보기"
          data-testid={`profile-popover-${userId}`}
          // F4 (a11y M-2): non-modal Content 라 Tab 이 배경으로 새지 않도록 포커스
          // outside 를 막아 열린 dialog 안에 포커스를 가둔다. Esc/외부클릭 닫힘은
          // onPointerDownOutside/onEscapeKeyDown 기본 동작이라 보존된다.
          onFocusOutside={(e) => e.preventDefault()}
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

                {/*
                  역할 뱃지 ≤3 + 초과분 "+N" 더보기.
                  F7 (a11y H-2): 역할 컨테이너에 role="list"/aria-label, 각 뱃지에
                  role="listitem" 을 부여해 스크린리더에 역할 목록으로 노출한다(DS
                  클래스명은 유지 — role 속성만 추가).
                */}
                {data.customRoles.length > 0 ? (
                  <div
                    className="qf-hovercard__roles"
                    data-testid={`profile-roles-${userId}`}
                    role="list"
                    aria-label="역할"
                  >
                    {data.customRoles.slice(0, MAX_ROLE_BADGES).map((r) => (
                      <span
                        key={r.id}
                        role="listitem"
                        className="qf-badge"
                        style={r.color ? { color: r.color, borderColor: r.color } : undefined}
                      >
                        {r.name}
                      </span>
                    ))}
                    {data.customRoles.length > MAX_ROLE_BADGES ? (
                      // F12 (a11y N-2): "+N" 뱃지에 접근명 부여.
                      <span
                        role="listitem"
                        className="qf-badge"
                        data-testid={`profile-roles-more-${userId}`}
                        aria-label={`역할 ${data.customRoles.length - MAX_ROLE_BADGES}개 더 있음`}
                      >
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
