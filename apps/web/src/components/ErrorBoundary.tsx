import { Component, type ErrorInfo, type ReactNode } from 'react';
import { friendlyError, RECOVERY_LABEL } from '../lib/error-messages';

/**
 * task-047 iter7 (P4): 앱 전역 ErrorBoundary.
 *
 * unhandled render error 를 catch 해 friendlyError 로 한국어 메시지 +
 * recovery action 노출. 자식 트리가 unmount 되더라도 root 가 살아있어
 * navigation 가능.
 *
 * 정책:
 *  - error 발생 → console.error 로 telemetry (기존 보고 채널 유지)
 *  - friendlyError 의 recovery 가 'retry' / 'refresh' 면 명시 버튼
 *  - reset 시 자식 re-mount (key 토글)
 */

interface Props {
  children: ReactNode;
  /** test 또는 storybook 에서 외부 reset 트리거 */
  onReset?: () => void;
}

interface State {
  error: Error | null;
  resetCount: number;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetCount: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Production 에선 외부 telemetry (Sentry / OTEL exporter 등) 으로 보고.
    // 본 boundary 는 console.error fallback.
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  reset = (): void => {
    this.setState((s) => ({ error: null, resetCount: s.resetCount + 1 }));
    this.props.onReset?.();
  };

  render(): ReactNode {
    if (!this.state.error) {
      // resetCount 가 key 로 작동해 reset 시 children re-mount
      return <div key={this.state.resetCount}>{this.props.children}</div>;
    }
    const f = friendlyError(this.state.error);
    const showRetry = f.recovery === 'retry' || f.recovery === 'refresh';
    return (
      <div
        data-testid="app-error-boundary"
        className="flex min-h-screen flex-col items-center justify-center gap-[var(--s-3)] p-[var(--s-5)] text-center"
      >
        <h1 className="text-[length:var(--fs-18)] font-semibold">문제가 발생했습니다</h1>
        <p className="max-w-md text-[length:var(--fs-14)] text-text-muted">{f.message}</p>
        <div className="mt-[var(--s-2)] flex gap-[var(--s-2)]">
          {showRetry ? (
            <button
              type="button"
              data-testid="error-boundary-retry"
              className="qf-btn qf-btn--primary"
              onClick={this.reset}
            >
              {RECOVERY_LABEL[f.recovery]}
            </button>
          ) : null}
          <button
            type="button"
            data-testid="error-boundary-home"
            className="qf-btn qf-btn--ghost"
            onClick={() => {
              window.location.href = '/';
            }}
          >
            홈으로
          </button>
        </div>
      </div>
    );
  }
}
