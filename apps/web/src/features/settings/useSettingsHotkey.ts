import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * S76 (D14 / FR-PS-18): Ctrl+,(Cmd+,) 전역 단축키로 설정 진입.
 *
 * Discord/VS Code parity. 입력 필드(input/textarea/contenteditable)에 포커스가 있어도
 * 콤마 단축키는 설정 진입을 의도하므로 가로채지 않는다(쉼표 자체 입력은 modifier 없는
 * 경우라 충돌하지 않음 — 여기선 ctrl/meta + ',' 만 처리). 이미 설정 경로면 no-op.
 */
export function useSettingsHotkey(): void {
  const navigate = useNavigate();
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        // 다른 modifier(alt/shift)와의 조합은 무시(정확히 ctrl/meta + ',' 만).
        if (e.altKey || e.shiftKey) return;
        e.preventDefault();
        navigate('/settings/appearance');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [navigate]);
}
