# Iteration 2 — AUDIT

## Score (시작)

- iteration 1 종료 시 81%
- HIGH 갭: 6개 잔여 (markdown 해소)

## 이번 iteration 선정

**Pinned messages** (Round A 항목 1, HIGH 갭 #1 — schema/UI 모두 0)

선정 사유:

- 시드 우선순위 #1
- 단독 iteration: schema migration + API + UI 가 동시에 따라옴 → 작은 항목과 묶기 어려움
- Discord/Slack 핵심 기능

## 현재 상태

- `Message` 모델: `pinnedAt` / `pinnedBy` 컬럼 없음
- API: `/messages/:id/pin` endpoint 없음
- UI: pin 아이콘 / pin 패널 없음 (단, DS `qf-pin-*` 클래스 부재 — DS 4파일 수정 금지이므로 page-scoped + Tailwind 만)
- Permission: WorkspaceMember role 'OWNER'|'ADMIN'|'MEMBER' 만 존재 (per-channel mod 별도 task)

## 제약

- DS 4파일 수정 금지 → page-scoped CSS / Tailwind utility 만
- Migration 은 reversible
- WS event 는 outbox-driven (기존 패턴 유지)
- UI 변화는 점진적: 우선 hover menu 의 pin/unpin + 메시지 행에 작은 pin 마커. Pinned panel 은 별도 phase 로 후속 처리.

## 측정

- 새 row 모델: 0 (Message 컬럼만 추가)
- 새 인덱스 1개: `(channelId, pinnedAt)` partial WHERE pinnedAt IS NOT NULL
- 새 endpoint 3개: POST/DELETE /pin + GET /pins
- 새 WS event 1개: `MESSAGE_PIN_TOGGLED`
- 신규 spec: int (3) + e2e (1)
