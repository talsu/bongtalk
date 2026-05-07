# Iteration 6 — AUDIT

## Score (시작)

- iter 5 종료 시 ≈ 91%

## 이번 iteration 선정

**Partial → Full 진급** — HIGH 갭 = 0 달성 시도

처리:

1. **Link unfurl FE binding** — `.qf-embed` 카드 컴포넌트 + parseContent URL wrap
2. **Mute dispatcher gate** — outbox emit 직전 filterMutedRecipients 호출

기타 partial → full 진급은 추가 iteration:

- custom status WS broadcast + UI: iter 7
- group DM listing + UI: iter 8

## 측정

- FE: LinkPreview 컴포넌트 + parseContent 통합 (~80 라인)
- BE: messages.service.ts mention 추출 후 mute filter 1-line 적용 + spec
