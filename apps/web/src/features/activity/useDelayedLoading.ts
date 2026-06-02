import { useEffect, useState } from 'react';

/**
 * S47 (FR-MN-13): 로딩 스켈레톤을 `delayMs`(기본 200ms) 이후에만 노출하는 hook.
 *
 * 빠른 응답(200ms 미만)에서는 스켈레톤을 띄우지 않아 깜빡임을 막고, 200ms 이상
 * 지연될 때만 `.qf-skeleton` 행을 보인다. isLoading 이 false 가 되면 즉시 false.
 *
 * 반환값이 true 일 때만 호출부가 스켈레톤을 렌더한다.
 */
export function useDelayedLoading(isLoading: boolean, delayMs = 200): boolean {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!isLoading) {
      setShow(false);
      return;
    }
    const t = setTimeout(() => setShow(true), delayMs);
    return () => clearTimeout(t);
  }, [isLoading, delayMs]);

  return show;
}
