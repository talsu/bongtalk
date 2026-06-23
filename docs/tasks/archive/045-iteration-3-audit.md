# Iteration 3 — AUDIT

## Score (시작)

- iter 2 종료 시 ≈ 88% (link unfurl BE 부분 +1.0)

## 이번 iteration 선정

**Channel/DM mute** (HIGH 갭 #4 — pref 가 event-type 단위만)

## 현재 상태

- `UserNotificationPreference` (event-type / workspace 단위 만)
- 채널 단위 / DM 단위 mute 없음
- 사용자가 시끄러운 채널 알림을 끌 수 없음

## 제약

- DS 4파일 수정 금지
- migration 1건 (UserChannelMute reversible)
- mute 정책: event-type pref 보다 우선 (mute > pref)

## 측정

- 신규 컬럼: UserChannelMute 테이블 (userId, channelId, mutedUntil?, unique)
- 신규 endpoint 3개: POST/DELETE channel mute, GET /me/mutes
- 신규 spec: service unit + dispatcher gate spec
- 영향 줄: ~250 라인
