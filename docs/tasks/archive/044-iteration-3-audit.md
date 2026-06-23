# Iteration 3 — AUDIT

## Score (시작)

- iteration 2 종료 시 ≈ 84% (pinned BE 부분 1.0 weight × 2 = 2.0 / total)
- HIGH 갭: 5개 잔여 (markdown 해소 + pinned 부분 해소; 부분 = 0.5 가중)

## 이번 iteration 선정

**@everyone / @here permission gate** (HIGH 갭 #5 — sender 권한 + receiver 분기 0)

대안 (round-B 시드 항목들):

- mute (medium) — 별도 iteration 권장
- group DM (large) — 단독 iteration
- custom status text (medium)

선정 사유:

- 가장 작은 표면 (mention-extractor 결과를 service 에서 후처리)
- 보안 영향 큰 결함: 현재 MEMBER 가 `@everyone` 작성 시 mentions.everyone=true 가 모든 클라이언트로 fanout 됨 — workspace 전원에게 알림 트리거
- BE 단독 변경, UI 영향 0

## 현재 상태

- `mention-extractor.ts` 의 `MENTION_EVERYONE_RE` 가 항상 검출 → mentions.everyone=true 그대로 저장
- service.send / service.update 에서 sender role 검증 없음
- 클라이언트 dispatcher 가 mentions.everyone=true 면 모든 채널 멤버에게 toast/푸시 emit

## 제약

- DS 4파일 수정 금지 (변경 없음)
- 메시지 contract (MessageDto.mentions.everyone) 호환 유지
- 기존 mention-extractor 의 순수성 유지 — 권한 정책은 service 계층

## 측정

- 신규 spec: int 1 (또는 unit 1) — MEMBER 가 @everyone 작성 시 silently strip 검증
- 신규 endpoint: 0
- 신규 컬럼: 0
- 영향 줄: < 30 라인
