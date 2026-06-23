# Iteration 1 — AUDIT

## Score (시작)

- 044 종료 시 86%
- iter 0 baseline seed 완료 (점수 영향 없음, 인프라)

## 이번 iteration 선정

**H1 pin-cap-race fix + pinned UI** (044 reviewer H1 + 044 iter 2 deferred UI)

선정 사유:

- 044 reviewer 의 첫 번째 fix 권고 (BLOCKER 등급은 아니지만 ToCToU race)
- pinned BE 가 이미 배포됐는데 UI 가 없어 사용자 입장에서 기능 부재 — 두 가지를 한 iteration 에 묶어 처리하면 시각적 + 기능적 완성

## 현재 상태 (코드 검토)

### H1 race window

- 위치: `apps/api/src/messages/messages.service.ts:935-948`
- 패턴: `tx.message.count(...)` 후 `tx.message.update(...)` — count + update 사이에 다른 transaction 이 update 하면 cap+1 가능
- PostgreSQL READ COMMITTED 격리 + advisory lock/SELECT FOR UPDATE 부재
- Discord/Slack 정책 동일 cap 50 (Slack 100 → 우리는 Discord 채택)

### Pinned UI 부재

- `MessageItem.tsx` 의 dropdown menu 에 Pin/Unpin 항목 없음
- 메시지 행 (`MessageRow`) 에 pinnedAt marker 없음
- WS dispatcher 가 MESSAGE_PIN_TOGGLED 이벤트 처리 안 함 → 실시간 동기화 X (페이지 새로고침 필요)

## 제약

- DS 4파일 수정 금지 → Tailwind utility (DS 토큰 alias) + `qf-i-pin` icon (이미 DS 등록) 사용
- migration 추가 안 함 (lock 은 query-time)
- 모바일 long-press menu 는 후속 처리 (deferred follow-up)
- Pinned panel drawer 는 후속 처리 (deferred follow-up)

## 측정

- 신규 spec: H1 race regression spec 1 (vi.fn() concurrent simulation) + pin dropdown UI spec 1
- 신규 endpoint: 0
- 신규 컬럼: 0
- 영향 줄: ~80 라인
