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
  Tooltip,
} from '../design-system/primitives';
import { useTheme } from '../design-system/theme/ThemeProvider';
import { useUI } from '../stores/ui-store';
import { usePresenceStatus } from '../features/presence/usePresenceStatus';
import type { PresenceStatus } from '../features/presence/presenceStatus';

const STATUS_LABEL: Record<PresenceStatus, string> = {
  online: '온라인',
  dnd: '방해 금지',
  offline: '오프라인',
};

export function BottomBar(): JSX.Element {
  const { user, logout } = useAuth();
  const { resolved, toggle } = useTheme();
  const setOpenModal = useUI((s) => s.setOpenModal);
  const { status, setStatus, pending } = usePresenceStatus('online');
  const [statusOpen, setStatusOpen] = useState(false);

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
            aria-label={`내 상태: ${STATUS_LABEL[status]} (변경하기)`}
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
              <div data-testid="home-status" className="text-[length:var(--fs-11)] text-text-muted">
                {STATUS_LABEL[status]}
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
            <span data-testid="presence-set-online">Online</span>
          </DropdownItem>
          <DropdownItem
            onSelect={() => {
              void setStatus('dnd');
            }}
          >
            <span data-testid="presence-set-dnd">Do not disturb</span>
          </DropdownItem>
          <DropdownSeparator />
          <DropdownItem disabled>
            <span data-testid="presence-invisible-disabled">Invisible — 곧 제공 예정</span>
          </DropdownItem>
          <DropdownSeparator />
          <DropdownItem asChild preventDefault={false}>
            <Link to="/settings" data-testid="bottom-bar-settings" className="w-full">
              Settings
            </Link>
          </DropdownItem>
        </DropdownContent>
      </DropdownRoot>

      <div className="flex items-center gap-1">
        <Tooltip label={resolved === 'dark' ? '라이트 모드' : '다크 모드'} side="top">
          <button
            data-testid="theme-toggle"
            aria-label="테마 전환"
            onClick={toggle}
            className="qf-btn qf-btn--ghost qf-btn--icon qf-btn--sm"
          >
            {resolved === 'dark' ? '☀' : '☾'}
          </button>
        </Tooltip>
        <Tooltip label="피드백 보내기" side="top">
          <button
            data-testid="feedback-open"
            aria-label="피드백 보내기"
            onClick={() => setOpenModal('feedback')}
            className="qf-btn qf-btn--ghost qf-btn--icon qf-btn--sm"
          >
            ✎
          </button>
        </Tooltip>
        <Tooltip label="단축키 (?)" side="top">
          <button
            data-testid="shortcut-help"
            aria-label="단축키 도움말"
            onClick={() => setOpenModal('shortcut-help')}
            className="qf-btn qf-btn--ghost qf-btn--icon qf-btn--sm"
          >
            ?
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
            ⎋
          </button>
        </Tooltip>
      </div>
    </footer>
  );
}
