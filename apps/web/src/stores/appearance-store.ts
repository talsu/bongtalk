import { create } from 'zustand';
import { DEFAULT_APPEARANCE, type AppearanceSettings } from '@qufox/shared-types';

/**
 * S76 (D14 / FR-PS-09): 외관 설정의 클라이언트 런타임 스토어.
 *
 * 서버 GET/PATCH 가 단일 출처지만, theme/density/chatFontSize 는 DOM 속성/변수로
 * 직접 반영되는 반면 clock24h 는 React 트리(MessageItem 시각 포맷)가 구독해야 하므로
 * 이 스토어가 라이브 값을 보유한다. useAppearanceSettings 의 onSuccess 가 set 한다.
 */
type AppearanceState = {
  settings: AppearanceSettings;
  set: (s: AppearanceSettings) => void;
};

export const useAppearanceStore = create<AppearanceState>((set) => ({
  settings: { ...DEFAULT_APPEARANCE },
  set: (s) => set({ settings: s }),
}));

/** MessageItem 등 시각 포맷 소비처용 셀렉터(clock24h 만 구독해 불필요한 리렌더 회피). */
export function useClock24h(): boolean {
  return useAppearanceStore((s) => s.settings.clock24h);
}

/**
 * S84c (FR-RC19): 링크 미리보기 전역 토글 셀렉터. MessageItem 이 구독해 false 면
 * unfurl embed(OG 카드) 렌더를 스킵한다(봇 rich embed 는 무관). 이 값만 구독해
 * 불필요한 리렌더를 피한다(useClock24h 선례).
 */
export function useLinkPreviewsEnabled(): boolean {
  return useAppearanceStore((s) => s.settings.linkPreviewsEnabled);
}
