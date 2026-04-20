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

export function OnboardingCard(): JSX.Element | null {
  const [dismissed, setDismissed] = useState<boolean>(() => isOnboardingDismissed());
  const { data } = useOnboardingStatus();

  const checks = rows(data);
  const complete = isOnboardingComplete(data);

  if (!dismissed && complete) {
    dismissOnboarding();
  }
  if (dismissed || complete) return null;

  const doneCount = checks.filter((c) => c.done).length;

  return (
    <section
      data-testid="onboarding-card"
      aria-label="베타 온보딩 체크리스트"
      className="m-[var(--s-3)] p-[var(--s-4)] text-[length:var(--fs-12)]"
      style={{
        background: 'var(--accent-subtle)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--r-md)',
      }}
    >
      <header className="mb-[var(--s-3)] flex items-center justify-between">
        <div>
          <div className="qf-eyebrow">beta · get started</div>
          <h3 className="mt-[var(--s-1)] text-[length:var(--fs-13)] font-semibold text-text-strong">
            qufox에 익숙해지기
          </h3>
        </div>
        <button
          type="button"
          data-testid="onboarding-dismiss"
          aria-label="온보딩 카드 닫기"
          onClick={() => {
            dismissOnboarding();
            setDismissed(true);
          }}
          className="qf-btn qf-btn--ghost qf-btn--icon qf-btn--sm"
        >
          ✕
        </button>
      </header>
      <p
        data-testid="onboarding-progress"
        className="mb-[var(--s-3)] text-[length:var(--fs-11)] text-text-muted"
      >{`${doneCount} / ${checks.length} 완료`}</p>
      <ul className="flex flex-col gap-[var(--s-2)]">
        {checks.map((c) => (
          <li
            key={c.label}
            data-testid={`onboarding-row-${c.label}`}
            className={c.done ? 'text-text-muted line-through' : 'text-text'}
          >
            <span className="mr-[var(--s-2)] inline-block w-4 text-center" aria-hidden>
              {c.done ? '✓' : '·'}
            </span>
            {c.label}
          </li>
        ))}
      </ul>
    </section>
  );
}
