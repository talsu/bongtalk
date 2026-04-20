import { useState } from 'react';
import {
  dismissOnboarding,
  isOnboardingComplete,
  isOnboardingDismissed,
  useOnboardingStatus,
  type OnboardingStatus,
} from './useOnboarding';

type CheckRow = { label: string; done: boolean };

function rows(s: OnboardingStatus | undefined): CheckRow[] {
  return [
    { label: '워크스페이스 만들기', done: !!s && s.workspaces >= 1 },
    { label: '두 번째 채널 만들기', done: !!s && s.channels >= 2 },
    { label: '멤버 초대 링크 생성', done: !!s && s.invitesIssued >= 1 },
    { label: '첫 메시지 보내기', done: !!s && s.messagesSent >= 1 },
  ];
}

/**
 * Task-016-C-1: 🚀 베타 setup card pinned to the sidebar top. All
 * checks green → auto-hides by writing to localStorage. Manual
 * dismissal via the X button is session-stable (the localStorage
 * flag doesn't clear on logout; operators who want to re-enable can
 * clear the key manually).
 */
export function OnboardingCard(): JSX.Element | null {
  const [dismissed, setDismissed] = useState<boolean>(() => isOnboardingDismissed());
  const { data } = useOnboardingStatus();

  const checks = rows(data);
  const complete = isOnboardingComplete(data);

  // Auto-dismiss once all four are green. Side effect in render is
  // intentional: the write is idempotent and the next render reads
  // it back on the next mount / tab reopen.
  if (!dismissed && complete) {
    dismissOnboarding();
  }
  if (dismissed || complete) return null;

  const doneCount = checks.filter((c) => c.done).length;

  return (
    <section
      data-testid="onboarding-card"
      aria-label="베타 온보딩 체크리스트"
      className="m-2 rounded-md border border-border-subtle bg-bg-accent/30 p-3 text-xs"
    >
      <header className="mb-2 flex items-center justify-between">
        <h3 className="font-semibold text-foreground">🚀 베타 시작하기</h3>
        <button
          type="button"
          data-testid="onboarding-dismiss"
          aria-label="온보딩 카드 닫기"
          onClick={() => {
            dismissOnboarding();
            setDismissed(true);
          }}
          className="rounded px-1 text-text-muted hover:bg-bg-muted hover:text-foreground"
        >
          ✕
        </button>
      </header>
      <p
        data-testid="onboarding-progress"
        className="mb-2 text-[11px] text-text-muted"
      >{`${doneCount} / ${checks.length}`}</p>
      <ul className="space-y-1">
        {checks.map((c) => (
          <li
            key={c.label}
            data-testid={`onboarding-row-${c.label}`}
            className={c.done ? 'line-through text-text-muted' : 'text-foreground'}
          >
            <span className="mr-1 inline-block w-4">{c.done ? '✅' : '⬜'}</span>
            {c.label}
          </li>
        ))}
      </ul>
    </section>
  );
}
