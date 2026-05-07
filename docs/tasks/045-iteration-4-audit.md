# Iteration 4 — AUDIT

## Score (시작)

- iter 3 종료 시 ≈ 89% (channel mute BE 부분 +1.0)

## 이번 iteration 선정

**Custom status text** (HIGH 갭 #7 — presence enum-only)

## 현재 상태

- `User.presencePreference` enum 'auto'/'dnd' 만 존재
- 자유 문자열 status (Discord 의 "Coding 🚀") 없음
- WS 의 `presence.updated` payload 가 onlineUserIds + dndUserIds 만

## 제약

- DS 4파일 수정 금지
- 짧은 max length (Discord 128자, 우리는 100자 보수적)
- WS 빈도 폭발 방지 — broadcast throttle 10s
- 현재 iteration 은 BE 만, UI affordance 는 follow-up

## 측정

- 신규 컬럼: User.customStatus (VARCHAR(100) nullable)
- 신규 endpoint: PATCH /me/profile/status
- 기존 me/profile GET 응답에 포함
- 영향 줄: ~150 라인
