import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 071-M3 F6 (FR-CH-23 / 감사 B-134·D-44) — 슬로우모드 쿨다운 카운트다운.
 *
 * 전 플랫폼 최초 구현(데스크톱도 종전엔 429 generic 토스트뿐) — features/
 * messages 공유 위치에 두어 데스크톱 후속 채택이 무료가 되게 한다.
 *
 *  - markSent(): 전송 직후 호출 — slowmodeSeconds 예측 카운트다운 시작(서버는
 *    전송 '성공' 시 쿨다운을 시작하므로 낙관 예측. 실패 시 약간의 과대 표시가
 *    날 수 있으나 429 재동기화가 보정).
 *  - syncFromRetryAfter(ms): 429 CHANNEL_SLOWMODE_ACTIVE 의 retryAfterMs 로
 *    서버 권위 잔여시간에 재동기화(F1 의 api.ts retryAfter 전달이 선행).
 */
export function useSlowmodeCooldown(slowmodeSeconds: number): {
  remainingSec: number;
  markSent: () => void;
  syncFromRetryAfter: (ms: number) => void;
} {
  const deadlineRef = useRef(0);
  const [remainingSec, setRemainingSec] = useState(0);

  const recompute = useCallback((): void => {
    const left = Math.max(0, Math.ceil((deadlineRef.current - Date.now()) / 1000));
    setRemainingSec(left);
  }, []);

  useEffect(() => {
    if (remainingSec <= 0) return;
    const t = window.setInterval(recompute, 1000);
    return () => window.clearInterval(t);
  }, [remainingSec, recompute]);

  const markSent = useCallback((): void => {
    if (slowmodeSeconds <= 0) return;
    deadlineRef.current = Date.now() + slowmodeSeconds * 1000;
    recompute();
  }, [slowmodeSeconds, recompute]);

  const syncFromRetryAfter = useCallback(
    (ms: number): void => {
      deadlineRef.current = Date.now() + Math.max(0, ms);
      recompute();
    },
    [recompute],
  );

  return { remainingSec, markSent, syncFromRetryAfter };
}
