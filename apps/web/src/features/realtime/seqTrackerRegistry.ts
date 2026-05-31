import type { SeqTracker } from './seqTracker';

/**
 * S10 fix-forward (FIX #5): 활성 SeqTracker 인스턴스의 모듈 레벨 레지스트리.
 *
 * SeqTracker 는 소켓 생명주기(installChannelSync)의 클로저 안에 살아 외부에서
 * 직접 닿을 수 없습니다. 한편 채널 LRU evict(runChannelLruEntry)는 React Query
 * 캐시와 channelSyncStore 만 정리하고 SeqTracker 는 건드리지 못해, evict 된
 * 채널을 재진입하면 stale lastSeq 가 남아 첫 라이브 이벤트가 불필요한 hole 로
 * 판정 → 헛 gap-fetch 가 돕니다.
 *
 * 그래서 installChannelSync 가 자신의 tracker 를 여기 등록(setActiveSeqTracker)
 * 하고, LRU evict 경로가 resetSeqForChannel 로 해당 채널만 reset 하게 배선합니다.
 * 소켓은 앱당 단일이라(useRealtimeConnection 이 1회 설치) 활성 tracker 도 1개뿐
 * 입니다. detach 시 동일 인스턴스면 등록 해제합니다(소켓 교체 레이스 방어).
 */
let active: SeqTracker | null = null;

export function setActiveSeqTracker(tracker: SeqTracker | null): void {
  active = tracker;
}

/** detach 시 호출 — 등록된 게 이 인스턴스일 때만 비웁니다(레이스 방어). */
export function clearActiveSeqTracker(tracker: SeqTracker): void {
  if (active === tracker) active = null;
}

/** 채널 evict 시 활성 tracker 의 해당 채널 추적을 비웁니다(없으면 no-op). */
export function resetSeqForChannel(channelId: string): void {
  active?.reset(channelId);
}
