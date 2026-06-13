# 072-N0 진행 — 메시지 행·반응 표면 (공용 기반)

> 단일 진실원. 계획: `docs/tasks/072-desktop-uiux-overhaul.md` N0 절. 감사: `docs/audits/2026-06-13-desktop-uiux-audit.md`.
> 규약·검증·배포 071 동일. 브랜치 feat/072-n0-message-reactions (develop e59fa3b 기점).
> 데스크톱 e2e = apps/web/e2e/{messages,...}(mobile 별도). DS 4파일 frozen.

## 청크

| 청크 | 내용                                                                      | 상태 | 커밋 |
| ---- | ------------------------------------------------------------------------- | ---- | ---- |
| N0-1 | hover 툴바 퀵반응 3종 + 미읽표시 위치(HIGH)                               | todo |      |
| N0-2 | 반응 칩 hover 툴팁 — BE previewUsers≤5 + ReactionBar .qf-tooltip (MEDIUM) | todo |      |
| N0-3 | 본인 멘션 하이라이트 행 — astMentionsViewer 공통화 (MEDIUM)               | todo |      |
| N0-4 | 이모지 피커 검색창 + 스킨톤 선택기 (MEDIUM×2)                             | todo |      |
| N0-5 | 스레드 루트 리치 렌더 + 코드블록 헤더/복사 + embed suppress✕ (MEDIUM/LOW) | todo |      |
| N0-6 | (D3=c) FR-RC01 WYSIWYG — PRD 정정+감사 노트(코드 무변경)                  | todo |      |
| N0-G | 게이트: 데스크톱 e2e(messages/reactions) + standalone verify + 적대 리뷰  | todo |      |
| N0-D | develop 머지→main 승격→배포→/readyz→REPORT                                | todo |      |

## 노트

- 서브에이전트 브리프 필수: "읽기 전용 영역 외 수정 금지 / git checkout·branch·머지·배포·prod 금지 / DS 4파일 무수정".
- MessageItem(L861~ 툴바) 동일파일 다수 청크 → 순차. EmojiPicker·BE 는 독립 병렬.
- 공유 컴포넌트 수정 시 모바일 회귀 주의(071 e2e 53스펙 가드) — 데스크톱 분기 보존.
