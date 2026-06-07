/**
 * S87 (FR-MN-18): push 구독을 전송 시점에 데스크톱/모바일로 분류하는 순수 함수.
 *
 * PushSubscription.ua(브라우저 user-agent)만으로 분류한다 — 스키마 컬럼 불필요(ua 보존분
 * 으로 충분·재분류 자유). 채널 effective per-device 게이트(push.processor)가 이 분류로
 * 각 구독을 desktop/mobile 버킷에 넣어 해당 device 가 enabled 인 구독에만 전송한다.
 *
 * 정책(보수적): 모바일을 명시하는 알려진 토큰이 ua 에 있을 때만 'mobile'. 그 외(데스크톱
 * 브라우저·빈값·null·미인식)는 전부 'desktop'. PRD(FR-MN-18) 일관 — iOS PWA 특수 분기나
 * 정밀 fingerprinting 은 비목표(과분류로 데스크톱 OFF 시 모바일까지 끊기는 오작동 회피).
 */

/**
 * 모바일 device 를 명시하는 user-agent 토큰(대소문자 무관 매칭). 데스크톱 OS 토큰
 * (Windows NT / Macintosh / X11)은 포함하지 않는다 — 데스크톱이 기본값이라 불필요.
 *   - Android : 안드로이드 폰/태블릿(Chrome/Firefox/Samsung Internet).
 *   - iPhone/iPod/iPad : iOS Safari/Chrome.
 *   - Mobile : 다수 모바일 브라우저가 공통으로 싣는 토큰(예: "Mobile Safari").
 *   - Windows Phone / IEMobile : 레거시 Windows 모바일.
 *   - BlackBerry / Opera Mini / Opera Mobi / webOS / Kindle / Silk : 기타 모바일.
 */
const MOBILE_UA_REGEX =
  /\b(Android|iPhone|iPod|iPad|Mobile|Windows Phone|IEMobile|BlackBerry|BB10|Opera Mini|Opera Mobi|webOS|Kindle|Silk)\b/i;

/**
 * user-agent 를 'mobile' 또는 'desktop' 으로 분류한다. null/undefined/빈 문자열은 보수적
 * 으로 'desktop'(데스크톱 토글이 더 흔하게 켜져 있고, 미상 구독을 모바일 OFF 로 끊는 것보다
 * 데스크톱 OFF 로 끊는 편이 의도에 가깝다 — 데스크톱은 사용자가 명시 OFF 해야 끊긴다).
 */
export function classifyPushDevice(ua: string | null | undefined): 'mobile' | 'desktop' {
  if (!ua) return 'desktop';
  return MOBILE_UA_REGEX.test(ua) ? 'mobile' : 'desktop';
}
