# 061 · S87 — 채널별 데스크톱/모바일 독립 알림 (FR-MN-18)

## Context

PRD FR-MN-18: 채널별 모바일/데스크톱 독립 알림 설정 — 채널 오버라이드에서 데스크톱과
모바일 push 수준을 각각 설정한다.

기반: S86(FR-MN-15) Web Push LIVE. 현재 push.processor 는 글로벌 `UserSettings.notifDesktop/
notifMobile`(둘 다 OFF면 skip)만 보고 `sendToUser` 가 사용자의 **모든** 구독에 전송한다
(device 구분 없음). 채널 오버라이드는 `UserChannelMute.level`(S46)에 있다. PushSubscription
은 `ua`(user-agent)를 저장한다 → 전송 시점 device(desktop/mobile) 분류 가능.

## 아키텍처 결정

- **채널 per-device 토글**: `UserChannelMute` 에 `pushDesktop Boolean?` + `pushMobile Boolean?`
  추가(null = 글로벌 notifDesktop/notifMobile 상속 — additive·무회귀). 별도 테이블 대신
  기존 채널 오버라이드 행 재사용(S46 deviation 일관).
- **device 분류**: PushSubscription.ua 를 전송 시점에 순수 함수로 분류(`classifyPushDevice(ua)
→ 'mobile' | 'desktop'`, shared-types). 스키마 컬럼 불필요(ua 보존분으로 충분 · 재분류 자유).
- **전송 게이트**: push.processor 가 채널 effective per-device 산정
  (desktopEnabled = channelMute.pushDesktop ?? settings.notifDesktop ?? true · mobile 동일).
  둘 다 false → skip. `sendToUser(userId, payload, { desktopEnabled, mobileEnabled })` 가
  각 구독을 ua 로 분류해 해당 device 가 enabled 인 구독에만 전송(기본 둘 다 true = S86 무회귀).
- 마이그레이션 `20260626000000_s87_channel_device_push`(additive nullable · reversible).

## Scope

### IN

- **Prisma**: `UserChannelMute.pushDesktop Boolean?` + `pushMobile Boolean?` + 마이그레이션.
- **shared-types**: `classifyPushDevice(ua)` 순수 함수(mobile UA 정규식 — userAgent 분기
  없이 단일 규칙·PRD 일관) + 채널 알림 prefs 요청에 pushDesktop/pushMobile optional 필드.
- **API**:
  - 채널 알림 prefs set 경로(notif-preferences.service · 채널 level/mute set 컨트롤러)에
    pushDesktop/pushMobile 부분 갱신 추가. GET 응답에 노출.
  - push.service `sendToUser` 에 device 게이트 옵션 추가(각 구독 ua 분류 → 해당 device
    enabled 인 것만 전송). push.processor 가 채널 effective per-device 산정해 전달
    (둘 다 false → skip · S86 멤버십/DND/mute/read 게이트는 유지).
- **web**: 채널 알림 설정 UI(NotifLevelRadio/채널 설정 surface)에 데스크톱/모바일 push
  토글 2개 추가(글로벌 상속 = 미설정 표시). DS qf-\*/토큰만.
- **tests**: shared-types classifyPushDevice(mobile/desktop UA 표) · API 단위(per-device
  게이트: 채널 mobile OFF 면 모바일 구독 미전송·데스크톱 전송) + 통합(채널 pushDesktop/
  Mobile 왕복) · web 단위(토글 렌더·상속 표시).

### OUT (non-goals)

- 서버(워크스페이스) 단위 per-device(채널 오버라이드만 — PRD 일관).
- 정밀 device fingerprinting(ua 정규식 휴리스틱으로 충분).
- iOS PWA 특수 분기(userAgent 분기 없음 — PRD 일관).

## Acceptance Criteria (기계 검증)

- `pnpm verify`(node20) GREEN.
- 채널 pushDesktop/pushMobile 부분 갱신·GET 왕복(통합·실DB).
- per-device 게이트: 채널 mobile OFF + 데스크톱 ON → 모바일 UA 구독 미전송·데스크톱 UA 전송
  (단위, web-push mock).
- classifyPushDevice 가 대표 모바일/데스크톱 UA 를 정확히 분류(단위).

## Non-goals / Risks

- ua 휴리스틱 분류 오분류 여지(보수적 — 모바일 명시 토큰만 mobile, 그 외 desktop).
- null=상속 의미 보존(기존 채널 행 무회귀).
- 마이그레이션 reversible(additive nullable · down DROP COLUMN ×2).

## DoD

- 체크리스트 green + `pnpm verify` + reviewer(adversarial) 통과.
- fr-matrix FR-MN-18 = done · 핸드오프 갱신. 수동 배포(승인 후).
