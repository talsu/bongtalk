import { useWorkspace } from '../workspaces/useWorkspaces';
import { OnboardingOverlayGate } from './OnboardingOverlay';
import { useOnboardingState, shouldShowOnboarding } from './useOnboardingState';

/**
 * S71 (D13 / FR-W07·W08·W09): 온보딩 마운트 게이트. 워크스페이스별 상태 + 본인 역할(myRole)을
 * 읽어 표시 조건을 만족할 때만 OnboardingOverlay 를 렌더한다(OWNER 면제·빈 카탈로그 미표시 —
 * Fork A-1).
 *
 * fix-forward (ui INFO · 기능 필수): 데스크톱(Shell)·모바일(MobileShell) 양쪽 셸이 마운트한다.
 * 규칙 동의 게이트가 서버측(send/react · complete)이라, 모바일 가입자에게 오버레이가 없으면
 * 메시지가 영구 차단된다. 호스트를 별도 모듈로 둬 Shell ↔ MobileShell 순환 import 를 피한다.
 */
export function OnboardingHost({
  workspaceId,
  slug,
}: {
  workspaceId: string;
  slug: string;
}): JSX.Element | null {
  const { data: detail } = useWorkspace(workspaceId);
  const { data: state } = useOnboardingState(slug);
  const show = shouldShowOnboarding(state, detail?.myRole ?? null);
  return <OnboardingOverlayGate slug={slug} state={state} show={show} />;
}
