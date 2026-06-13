import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../features/auth/AuthProvider';
import {
  Avatar,
  DropdownRoot,
  DropdownTrigger,
  DropdownContent,
  DropdownItem,
  DropdownSeparator,
  Icon,
  Tooltip,
} from '../design-system/primitives';
import { useTheme } from '../design-system/theme/ThemeProvider';
import { useUI } from '../stores/ui-store';
import { usePresenceStatus } from '../features/presence/usePresenceStatus';
import type { PresenceStatus } from '../features/presence/presenceStatus';
import { useCustomStatus } from '../features/presence/useCustomStatus';
import { CustomStatusModal } from '../features/presence/CustomStatusModal';

const STATUS_LABEL: Record<PresenceStatus, string> = {
  online: '온라인',
  // S25 (FR-RT-10): auto-idle 표기. 사용자가 직접 설정하진 않지만 자동전환 시 표시.
  idle: '자리비움',
  dnd: '방해 금지',
  offline: '오프라인',
};

export function BottomBar(): JSX.Element {
  const { user, logout } = useAuth();
  const { resolved, toggle } = useTheme();
  const setOpenModal = useUI((s) => s.setOpenModal);
  const { status, setStatus, pending } = usePresenceStatus('online');
  const [statusOpen, setStatusOpen] = useState(false);
  // 072-N2: 커스텀 상태(이모지+텍스트) 표시 + 편집 모달 진입.
  const { data: customStatus } = useCustomStatus();
  const [customOpen, setCustomOpen] = useState(false);
  const customLabel = customStatus?.text || customStatus?.emoji ? customStatus : null;
  // 072-N2(리뷰 LOW): 프레즌스 라벨과 커스텀 상태를 함께 노출(둘 중 하나만 보이면
  // 사용자가 자기 프레즌스/오프라인 여부를 텍스트로 확인 못 함 — ProfilePopover 와 정합).
  const customText = customLabel
    ? `${customLabel.emoji ? `${customLabel.emoji} ` : ''}${customLabel.text ?? ''}`.trim()
    : '';
  const statusLine = customText ? `${STATUS_LABEL[status]} · ${customText}` : STATUS_LABEL[status];

  return (
    <footer
      data-testid="bottom-bar"
      className="flex h-10 shrink-0 items-center justify-between border-t border-border-subtle bg-bg-panel px-3 text-[length:var(--fs-13)]"
    >
      <DropdownRoot open={statusOpen} onOpenChange={setStatusOpen}>
        <DropdownTrigger asChild>
          <button
            type="button"
            data-testid="presence-status-trigger"
            data-presence={status}
            aria-label={`내 상태: ${statusLine} (변경하기)`}
            disabled={pending}
            className="flex items-center gap-2 rounded-[var(--r-sm)] px-[var(--s-2)] py-[var(--s-1)] hover:bg-bg-hover focus-visible:bg-bg-hover"
          >
            <Avatar name={user?.username ?? '??'} size="sm" status={status} />
            <div className="leading-tight text-left">
              <div
                data-testid="home-username"
                className="text-[length:var(--fs-13)] font-semibold text-text-strong"
              >
                {user?.username ?? ''}
              </div>
              <div
                data-testid="home-status"
                className="truncate text-[length:var(--fs-11)] text-text-muted"
              >
                {/* 072-N2: 프레즌스 라벨 + (있으면) 커스텀 상태를 함께 노출. */}
                {statusLine}
              </div>
            </div>
          </button>
        </DropdownTrigger>
        <DropdownContent align="start">
          <DropdownItem
            onSelect={() => {
              void setStatus('online');
            }}
          >
            <span data-testid="presence-set-online">온라인</span>
          </DropdownItem>
          <DropdownItem
            onSelect={() => {
              void setStatus('dnd');
            }}
          >
            <span data-testid="presence-set-dnd">방해 금지</span>
          </DropdownItem>
          {/* 072-N2(D1·FR-P01): Invisible 활성화 — setStatus('offline')은 wire
              'invisible' 로 PATCH(서버 허용). 라벨은 PRD '오프라인으로 표시'. */}
          <DropdownItem
            onSelect={() => {
              void setStatus('offline');
            }}
          >
            <span data-testid="presence-set-invisible">오프라인으로 표시</span>
          </DropdownItem>
          <DropdownSeparator />
          {/* 072-N2(FR-P04/P17): 커스텀 상태 편집 진입. 메뉴를 닫고(preventDefault=false)
              모달을 연다 — 메뉴를 연 채로 두면(preventDefault) 열린 DropdownMenu 포커스
              스코프가 Dialog 위에 남아 모달이 표면화되지 않는다(e2e 발견). 닫힘 시
              트리거로 포커스 복귀 후 Dialog 가 포커스를 트랩한다. */}
          <DropdownItem
            preventDefault={false}
            onSelect={() => {
              setStatusOpen(false);
              setCustomOpen(true);
            }}
          >
            <span data-testid="bottom-bar-custom-status">
              {customLabel ? '커스텀 상태 변경' : '커스텀 상태 설정'}
            </span>
          </DropdownItem>
          <DropdownSeparator />
          {/* task-033-H: Activity entry point from the desktop profile
              menu. Mobile gets the same surface via the tabbar 활동 tab. */}
          <DropdownItem asChild preventDefault={false}>
            <Link to="/activity" data-testid="bottom-bar-activity" className="w-full">
              활동
            </Link>
          </DropdownItem>
          <DropdownItem asChild preventDefault={false}>
            <Link to="/settings" data-testid="bottom-bar-settings" className="w-full">
              설정
            </Link>
          </DropdownItem>
        </DropdownContent>
      </DropdownRoot>

      <CustomStatusModal open={customOpen} onOpenChange={setCustomOpen} />

      <div className="flex items-center gap-1">
        <Tooltip label={resolved === 'dark' ? '라이트 모드' : '다크 모드'} side="top">
          <button
            data-testid="theme-toggle"
            aria-label="테마 전환"
            onClick={toggle}
            className="qf-btn qf-btn--ghost qf-btn--icon qf-btn--sm"
          >
            <Icon name={resolved === 'dark' ? 'sun' : 'moon'} size="sm" />
          </button>
        </Tooltip>
        <Tooltip label="피드백 보내기" side="top">
          <button
            data-testid="feedback-open"
            aria-label="피드백 보내기"
            onClick={() => setOpenModal('feedback')}
            className="qf-btn qf-btn--ghost qf-btn--icon qf-btn--sm"
          >
            <Icon name="edit" size="sm" />
          </button>
        </Tooltip>
        <Tooltip label="단축키 (?)" side="top">
          <button
            data-testid="shortcut-help"
            aria-label="단축키 도움말"
            onClick={() => setOpenModal('shortcut-help')}
            className="qf-btn qf-btn--ghost qf-btn--icon qf-btn--sm"
          >
            <Icon name="help" size="sm" />
          </button>
        </Tooltip>
        <Tooltip label="로그아웃" side="top">
          <button
            data-testid="logout-btn"
            aria-label="로그아웃"
            onClick={() => {
              void logout();
            }}
            className="qf-btn qf-btn--ghost qf-btn--icon qf-btn--sm"
          >
            <Icon name="logout" size="sm" />
          </button>
        </Tooltip>
      </div>
    </footer>
  );
}
