# 072-N4 진행 — 검색·단축키

> 계획: `docs/tasks/072-desktop-uiux-overhaul.md` N4. 브랜치 feat/072-n4-search (develop 4f7bc3a 기점).

## 청크

| 청크 | 내용 | 상태 | 커밋 |
| ---- | ---- | ---- | ---- |
| N4-1 | onJump 에서 closeSearchPanel 제거 — 점프 후 패널 유지 (HIGH·P0) | green | |
| N4-2 | useSearch sort 파라미터(relevance/recent) + SearchResultPanel 정렬 탭(.qf-tabs) (MEDIUM) | green | |
| N4-3 | Ctrl/Cmd+G + placeholder + 포맷 단축키 PRD 정리 (LOW) | deferred | |
| N4-G | 게이트: 단위(sort/contract) + standalone verify + 적대 리뷰(wqpljje7u) | green | (fix-forward) |
| N4-D | develop 머지→main 승격→배포→/readyz→REPORT | todo | |

## N4-G 적대 리뷰(wqpljje7u — 13 에이전트·3각도) fix-forward

raw 9 → confirmed 9(코드 결함 + 삭제된 e2e 관련 findings 포함).

**수리 완료:**

- **MEDIUM(재클릭 stale ?msg)**: N4-1 으로 패널이 점프 후 유지되면서 같은 결과 재클릭 시
  MessageList consumedJumpRef 가 안 풀려 재점프 안 됨 + ?msg 잔존 → jumpMessageId 가 null 로
  비워질 때 consumedJumpRef 리셋(MessageList.tsx) → 재점프 가능.
- **HIGH(정렬 탭 a11y)**: WAI-ARIA tablist 키보드 — roving tabindex(선택만 0)·ArrowLeft/Right
  이동+선택·aria-controls→search-panel-results(role=tabpanel·aria-labelledby).
- **LOW(정렬 토글 깜빡임)**: useSearch placeholderData=keepPreviousData → 정렬 전환 시 이전 결과
  유지(스피너 flash 제거).

**e2e 대체**: Ctrl+/(S83c 로 치트시트 모달로 변경)·Ctrl+F(컴포저 포커스 시 입력가드로 차단) 때문에
결과 패널을 e2e 로 결정적으로 열기 어려워, 프래자일 e2e 대신 결정적 단위 스펙(SearchPanelSort.spec:
정렬 탭 roving/arrow/tabpanel + onJump 무-closeSearchPanel 계약)으로 고정.

**이월**: N4-3(Ctrl/Cmd+G·포맷 단축키 PRD) → 후속.

## 노트

- N4-1: SearchResultPanelContainer.onJump 가 navigate 후 closeSearchPanel() 호출 → 제거(패널 유지).
- N4-2: SearchSort='relevance'|'recent' (api 이미 sort 지원). useSearch queryKey 에 sort 포함, 컨테이너
  state + SearchResultPanel role=tablist 정렬 탭. 쿼리 변경 시 정렬 유지.
- N4-3 이월: Ctrl/Cmd+G(find-again) 는 단축키 등록 시스템(useShortcut) 변경 필요 + 포맷 단축키는 PRD-doc
  작업 → LOW 후속. D4(퀵스위처 소스)는 'keep client' 결정으로 변경 없음.
