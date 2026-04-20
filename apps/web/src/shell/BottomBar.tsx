import { useAuth } from '../features/auth/AuthProvider';
import { Avatar, PresenceDot, Tooltip } from '../design-system/primitives';
import { useTheme } from '../design-system/theme/ThemeProvider';
import { useUI } from '../stores/ui-store';

/**
 * The 32px-ish strip at the very bottom. Avatar + username on the left,
 * quick controls (theme toggle, shortcut help, logout) on the right.
 */
export function BottomBar(): JSX.Element {
  const { user, logout } = useAuth();
  const { resolved, toggle } = useTheme();
  const setOpenModal = useUI((s) => s.setOpenModal);

  return (
    <footer
      data-testid="bottom-bar"
      className="flex h-10 shrink-0 items-center justify-between border-t border-border-subtle bg-bg-subtle px-3 text-xs"
    >
      <div className="flex items-center gap-2">
        <div className="relative">
          <Avatar name={user?.username ?? '??'} size="sm" />
          <span className="absolute -right-0.5 -bottom-0.5">
            <PresenceDot status="online" size="xs" />
          </span>
        </div>
        <div className="leading-tight">
          <div data-testid="home-username" className="font-medium text-foreground">
            {user?.username ?? ''}
          </div>
          <div className="text-[10px] text-text-muted">online</div>
        </div>
      </div>

      <div className="flex items-center gap-1">
        <Tooltip label={resolved === 'dark' ? '라이트 모드' : '다크 모드'} side="top">
          <button
            data-testid="theme-toggle"
            aria-label="테마 전환"
            onClick={toggle}
            className="rounded-md p-1.5 text-text-muted hover:bg-bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {resolved === 'dark' ? '☀' : '☾'}
          </button>
        </Tooltip>
        <Tooltip label="피드백 보내기" side="top">
          <button
            data-testid="feedback-open"
            aria-label="피드백 보내기"
            onClick={() => setOpenModal('feedback')}
            className="rounded-md p-1.5 text-text-muted hover:bg-bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            💬
          </button>
        </Tooltip>
        <Tooltip label="단축키 (?)" side="top">
          <button
            data-testid="shortcut-help"
            aria-label="단축키 도움말"
            onClick={() => setOpenModal('shortcut-help')}
            className="rounded-md p-1.5 text-text-muted hover:bg-bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
            className="rounded-md p-1.5 text-text-muted hover:bg-bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            ⎋
          </button>
        </Tooltip>
      </div>
    </footer>
  );
}
