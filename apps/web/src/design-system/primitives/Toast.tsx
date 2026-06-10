import { useCallback, useEffect, useRef, useState } from 'react';
import { useNotifications, type Notification } from '../../stores/notification-store';
import { cn } from '../../lib/cn';
import { toastContainerKind, toastLiveAriaLive, toastLiveRole } from './toastRole';

const variantClass: Record<Notification['variant'], string> = {
  info: '',
  success: 'qf-toast--success',
  warning: 'qf-toast--warn',
  danger: 'qf-toast--danger',
  mention: 'qf-toast--success',
};

/**
 * S24 fix-forward (a11y BLOCKER #6 + MOD #8): Toast live-region 정리 + Undo 타이밍.
 *
 *  - 외부 컨테이너는 role="region" + aria-label 만 둔다(중첩 aria-live 제거 —
 *    종전 컨테이너 aria-live="polite" + 각 토스트 role/aria-live 가 SR 에 이중
 *    안내됐다). 각 토스트가 자기 role(status/alert)/aria-live 를 유지한다.
 *  - action 토스트(Undo 버튼 포함)는 role="status"(라이브 리전) 안에 인터랙티브
 *    button 을 중첩하지 않는다 — action 이 있으면 비-라이브 컨테이너(role 없음)로
 *    렌더해 버튼이 정상 인터랙티브하게 둔다. 텍스트만 있는 토스트는 종전대로
 *    status/alert.
 *  - WCAG 2.2.1: 토스트 hover/focus 시 자동 해제 타이머를 일시정지하고, 떠나면
 *    재개한다(SR/키보드 사용자가 Undo 를 누를 시간 확보). Undo 토스트 TTL 은
 *    호출부(UnreadsView)에서 8초로 잡아 추가 여유를 둔다.
 */
export function ToastViewport(): JSX.Element {
  const { items, dismiss } = useNotifications();
  // 토스트별 자동 해제 타이머. hover/focus 로 일시정지하고 leave/blur 로 재개한다.
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // 현재 일시정지된 토스트 id 집합(hover/focus 중). 정지 동안 타이머를 걸지 않는다.
  const [paused, setPaused] = useState<ReadonlySet<string>>(new Set());

  const clearTimer = useCallback((id: string) => {
    const t = timers.current.get(id);
    if (t) {
      clearTimeout(t);
      timers.current.delete(id);
    }
  }, []);

  useEffect(() => {
    for (const t of items) {
      // 이미 타이머가 걸려 있거나 일시정지 중이면 건드리지 않는다.
      if (timers.current.has(t.id) || paused.has(t.id)) continue;
      const ttl = t.ttlMs ?? 4000;
      timers.current.set(
        t.id,
        setTimeout(() => {
          timers.current.delete(t.id);
          dismiss(t.id);
        }, ttl),
      );
    }
    // store 에서 사라진 토스트의 잔여 타이머 정리.
    const live = new Set(items.map((t) => t.id));
    for (const id of [...timers.current.keys()]) {
      if (!live.has(id)) clearTimer(id);
    }
  }, [items, paused, dismiss, clearTimer]);

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const t of map.values()) clearTimeout(t);
      map.clear();
    };
  }, []);

  const pause = useCallback(
    (id: string) => {
      clearTimer(id);
      setPaused((prev) => {
        if (prev.has(id)) return prev;
        const next = new Set(prev);
        next.add(id);
        return next;
      });
    },
    [clearTimer],
  );

  const resume = useCallback((id: string) => {
    setPaused((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  return (
    <div
      role="region"
      aria-label="알림"
      // 071-M0 리뷰 M4: 모바일(<768px)에서 bottom 20px 앵커는 탭바(z=40) 위에 320px 토스트를
      // 얹어 TTL 동안 탭 2~3개의 터치를 가로챘다 — 모바일은 탭바+safe-area 위로 띄우고
      // 좌우 여백 안에 맞춘다. md(768px+)는 종전 우하단 그대로.
      className="pointer-events-none fixed z-toast flex flex-col gap-[var(--s-3)] bottom-[calc(var(--m-tabbar-h)+env(safe-area-inset-bottom)+var(--s-3))] right-[var(--s-3)] left-[var(--s-3)] md:bottom-[var(--s-5)] md:right-[var(--s-5)] md:left-auto items-end"
    >
      {items.map((t) => {
        const hasAction = typeof t.action?.onClick === 'function';
        // 컨테이너 종류는 toastRole.ts 단일 출처가 판정한다(테스트 대상 순수 로직).
        const kind = toastContainerKind(t);
        const interactive = kind === 'interactive-button';
        // hover/focus 자동-해제 일시정지 핸들러 묶음(모든 컨테이너 형태 공통).
        const pauseHandlers = {
          onMouseEnter: () => pause(t.id),
          onMouseLeave: () => resume(t.id),
          onFocus: () => pause(t.id),
          onBlur: () => resume(t.id),
        };
        const body = (
          <>
            <div className="flex-1">
              {t.title ? <div className="qf-toast__title">{t.title}</div> : null}
              {t.body ? <div className="qf-toast__body">{t.body}</div> : null}
            </div>
            {hasAction ? (
              <button
                type="button"
                data-testid={`toast-action-${t.variant}`}
                onClick={() => {
                  t.action?.onClick();
                  dismiss(t.id);
                }}
                className="qf-btn qf-btn--link qf-btn--sm shrink-0"
              >
                {t.action?.label}
              </button>
            ) : null}
          </>
        );
        if (interactive) {
          return (
            <button
              key={t.id}
              type="button"
              data-testid={`toast-${t.variant}`}
              role={toastLiveRole(t.variant)}
              aria-live={toastLiveAriaLive(t.variant)}
              {...pauseHandlers}
              onClick={() => {
                t.onActivate?.();
                dismiss(t.id);
              }}
              className={cn('qf-toast pointer-events-auto text-left', variantClass[t.variant])}
            >
              {body}
            </button>
          );
        }
        // a11y BLOCKER #6: action 이 있으면(kind==='plain-action') 라이브 리전
        // (role=status/alert) 을 쓰지 않는다 — 인터랙티브 button 을 라이브 리전에
        // 중첩하지 않도록 role 없는 컨테이너로 렌더하고, 안내는 내부 텍스트가 담당.
        if (kind === 'plain-action') {
          return (
            <div
              key={t.id}
              data-testid={`toast-${t.variant}`}
              {...pauseHandlers}
              className={cn('qf-toast pointer-events-auto', variantClass[t.variant])}
            >
              {body}
            </div>
          );
        }
        return (
          <div
            key={t.id}
            data-testid={`toast-${t.variant}`}
            role={toastLiveRole(t.variant)}
            aria-live={toastLiveAriaLive(t.variant)}
            {...pauseHandlers}
            className={cn('qf-toast pointer-events-auto', variantClass[t.variant])}
          >
            {body}
          </div>
        );
      })}
    </div>
  );
}
