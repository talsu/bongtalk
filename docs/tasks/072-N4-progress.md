# 072-N4 진행 — 검색·단축키

> 계획: `docs/tasks/072-desktop-uiux-overhaul.md` N4. 브랜치 feat/072-n4-search (develop 4f7bc3a 기점).

## 청크

| 청크 | 내용 | 상태 | 커밋 |
| ---- | ---- | ---- | ---- |
| N4-1 | onJump 에서 closeSearchPanel 제거 — 점프 후 패널 유지 (HIGH·P0) | green | |
| N4-2 | useSearch sort 파라미터(relevance/recent) + SearchResultPanel 정렬 탭(.qf-tabs) (MEDIUM) | green | |
| N4-3 | Ctrl/Cmd+G + placeholder + 포맷 단축키 PRD 정리 (LOW) | deferred | |
| N4-G | 게이트: 데스크톱 e2e(search) + standalone verify + 적대 리뷰 | todo | |
| N4-D | develop 머지→main 승격→배포→/readyz→REPORT | todo | |

## 노트

- N4-1: SearchResultPanelContainer.onJump 가 navigate 후 closeSearchPanel() 호출 → 제거(패널 유지).
- N4-2: SearchSort='relevance'|'recent' (api 이미 sort 지원). useSearch queryKey 에 sort 포함, 컨테이너
  state + SearchResultPanel role=tablist 정렬 탭. 쿼리 변경 시 정렬 유지.
- N4-3 이월: Ctrl/Cmd+G(find-again) 는 단축키 등록 시스템(useShortcut) 변경 필요 + 포맷 단축키는 PRD-doc
  작업 → LOW 후속. D4(퀵스위처 소스)는 'keep client' 결정으로 변경 없음.
