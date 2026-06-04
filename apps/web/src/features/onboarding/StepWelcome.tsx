import { forwardRef, useId } from 'react';
import type { WorkspaceWelcome } from '@qufox/shared-types';
import { Button } from '../../design-system/primitives';

/**
 * S71 (FR-W09): 온보딩 Step3 — 웰컴 화면. 환영 메시지 + 권장 to-do 목록을 보여주고
 * "시작하기"로 오버레이를 닫는다(시스템 DM·입장 메시지는 complete 시점 BullMQ 가 비동기 발송).
 *
 * a11y (S71 fix-forward):
 *  - BLK-2: 루트 div tabIndex=-1 + forwardRef(단계 전환 포커스 이동).
 *  - MAJOR-1: 소제목 <h3>(Dialog.Title h2 아래).
 *  - MINOR-4: todo 의 텍스트 bullet("•")은 aria-hidden 스팬으로 — list 마커가 중복 발화되지 않게.
 */
export const StepWelcome = forwardRef<
  HTMLDivElement,
  {
    welcome: WorkspaceWelcome;
    onDone: () => void;
  }
>(function StepWelcome({ welcome, onDone }, ref): JSX.Element {
  const headingId = useId();
  return (
    <div
      ref={ref}
      tabIndex={-1}
      aria-labelledby={headingId}
      className="flex flex-col gap-[var(--s-5)] outline-none"
      data-testid="onboarding-step-welcome"
    >
      <h3 id={headingId} className="text-text-strong text-[length:var(--fs-18)] font-semibold">
        환영합니다 🎉
      </h3>
      {welcome.message ? (
        <p className="text-foreground text-[length:var(--fs-14)]">{welcome.message}</p>
      ) : null}
      {welcome.todos.length > 0 ? (
        <div className="flex flex-col gap-[var(--s-2)]">
          <p className="text-text-strong font-medium text-[length:var(--fs-14)]">먼저 해보세요</p>
          <ul className="flex flex-col gap-[var(--s-1)]">
            {welcome.todos.map((todo, i) => (
              <li key={i} className="text-text-muted text-[length:var(--fs-13)]">
                <span aria-hidden="true">• </span>
                {todo}
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
});
