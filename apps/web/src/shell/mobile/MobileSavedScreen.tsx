import { useNavigate } from 'react-router-dom';
import { SavedView } from '../../features/saved/SavedView';
import { Icon } from '../../design-system/primitives';
import { MobileTabBar } from './MobileTabBar';

/**
 * 071-M3 F3 (FR-PS-07 모바일 / 감사 A-9·B-65) — 저장함 풀스크린 화면(/saved).
 *
 * 데스크톱 SavedView 는 props 없는 자기완결 3탭 뷰(진행/보관/완료 + 리마인더) —
 * 그대로 마운트한다. 진입점은 '나' 탭의 '저장됨' 행(useSavedCount 배지).
 * 항목 탭→원본 점프는 SavedMessageDto 에 워크스페이스 컨텍스트가 없어 보류
 * (데스크톱에도 없는 기능 — M4+ DTO 확장 후보, 071-M3-progress 기록).
 */
export function MobileSavedScreen(): JSX.Element {
  const navigate = useNavigate();
  return (
    <div data-testid="mobile-saved-screen" className="qf-m-screen qf-m-screen--app">
      <header className="qf-m-topbar qf-m-safe-top">
        <button
          type="button"
          data-testid="mobile-saved-back"
          className="qf-m-topbar__back"
          aria-label="뒤로"
          onClick={() => navigate('/you')}
        >
          <Icon name="chevron-left" size="md" />
        </button>
        <div className="qf-m-topbar__titleBlock">
          <div className="qf-m-topbar__title">저장됨</div>
        </div>
      </header>
      <main className="qf-m-body flex min-h-0 flex-col overflow-y-auto">
        <SavedView />
      </main>
      <MobileTabBar />
    </div>
  );
}
