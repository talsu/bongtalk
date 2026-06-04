import type { WorkspaceWelcome } from '@qufox/shared-types';
import { Button } from '../../design-system/primitives';

/**
 * S71 (FR-W09): 온보딩 Step3 — 웰컴 화면. 환영 메시지 + 권장 to-do 목록을 보여주고
 * "시작하기"로 오버레이를 닫는다(시스템 DM·입장 메시지는 complete 시점 BullMQ 가 비동기 발송).
 */
export function StepWelcome({
  welcome,
  stepLabel,
  onDone,
}: {
  welcome: WorkspaceWelcome;
  stepLabel: string;
  onDone: () => void;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-[var(--s-5)]" data-testid="onboarding-step-welcome">
      <p className="text-[length:var(--fs-12)] text-text-muted" aria-live="polite">
        {stepLabel}
      </p>
      <h2 className="text-text-strong text-[length:var(--fs-18)] font-semibold">환영합니다 🎉</h2>
      {welcome.message ? (
        <p className="text-foreground text-[length:var(--fs-14)]">{welcome.message}</p>
      ) : null}
      {welcome.todos.length > 0 ? (
        <div className="flex flex-col gap-[var(--s-2)]">
          <p className="text-text-strong font-medium text-[length:var(--fs-14)]">먼저 해보세요</p>
          <ul className="flex flex-col gap-[var(--s-1)]">
            {welcome.todos.map((todo, i) => (
              <li key={i} className="text-text-muted text-[length:var(--fs-13)]">
                • {todo}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="flex justify-end">
        <Button variant="primary" onClick={onDone} data-testid="onboarding-done">
          시작하기
        </Button>
      </div>
    </div>
  );
}
