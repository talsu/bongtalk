# 072-N6 진행 — 실시간·읽음·인증 + PRD/추적 동기화 + 검증 상시화

> 계획: `docs/tasks/072-desktop-uiux-overhaul.md` N6. 브랜치 feat/072-n6-sync-verify (develop 5770f40 기점).
> ★N6-5(D2/D5 DS 토큰 개정)는 **사용자 승인 게이트** — 자동 진행 금지.

## 스코프 확정(정찰)

N6 의 실시간/읽음 본체는 대부분 **서버 의존**이라 docs/검증 부분만 자율 수행하고, UI 본체는 이월.

| 항목                                                           | 판정                                                                               | 처리                           |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------ |
| N6-1 Unreads 미리보기 (HIGH)                                   | 서버 `GET /workspaces/:id/unreads`(채널별≤5+차단마스킹+cursor) 신설 동반           | 이월(서버 슬라이스)            |
| N6-2 Preview Tray 재정렬 (MEDIUM·P0)                           | @dnd-kit 프론트, tray 컴포넌트 한정                                                | 이월(독립 슬라이스로 가능)     |
| N6-3 연결 불가 안내 (MEDIUM)                                   | socket manager reconnect_failed + RealtimeStatus 'failed' 종단 — realtime plumbing | 이월                           |
| N6-3 세션 만료/탈취 배너 (FR-AUTH-55/56)                       | 인증/세션 이벤트 plumbing                                                          | 이월                           |
| N6-4 LOW(저장 원본이동·핀 메타·저장탭 카운트·2FA DS·배너 위계) | 혼합                                                                               | 이월(소규모 후속)              |
| **N6-5 D2/D5 DS 토큰**                                         | **사용자 D2+D5 일괄 승인**                                                         | ✅ 수행(아래 §N6-5)            |
| N6-6 PRD/fr-matrix 동기화                                      | docs only                                                                          | 자율 수행(본 문서 + 추적 노트) |
| N6-7 검증 상시화                                               | 슬라이스별 게이트로 대부분 충족                                                    | 자율 정리                      |

## N6-6 docs 동기화

- 072 데스크톱 오버홀 N0~N5 prod 배포 완료 — `docs/tasks/072-desktop-uiux-overhaul.md` 의 슬라이스별
  진행은 `072-N{0..5}-progress.md` 가 단일 진실원.
- 슬라이스별 서버 의존 이월 백로그(아래 §이월 백로그)를 단일 목록으로 집계 — 후속 서버 슬라이스 입력.

## N6-7 검증 상시화 — 데스크톱 커버리지(슬라이스 게이트로 충족)

- hover 퀵반응 툴바·반응자 툴팁·이모지 검색: `e2e/messages/n0-desktop-surfaces.e2e.ts`
- DM 그룹 생성/숨기기/검색무영향: `e2e/dms/n1-desktop-group-shell.e2e.ts`
- INVISIBLE·커스텀 상태 편집: `e2e/shell/n2-desktop-presence-status.e2e.ts`
- 채널 생성(타입/비공개/설명)·아카이브·prefix: `e2e/channels/n3-desktop-channels.e2e.ts`
- 검색 정렬/점프 계약: `src/features/search/SearchPanelSort.spec.tsx`(단위, 패널-오픈 e2e 프래자일 회피)
- 역할 카탈로그 모더레이션 비트: `roles/permissionCatalog.spec.ts`
- (잔여) axe 데스크톱 라우트 확대(현 login/signup/shell → settings/moderation): 후속.

## 이월 백로그 (072 전체 — 서버/승인 의존)

**서버 슬라이스 필요:**

- 워크스페이스 아이콘 업로드(presign/finalize) — N5-1
- 채널 둘러보기 per-channel memberCount + isMember(가입/열기 분기) — N3-3
- 그룹 DM 미읽음 집계(listGroups unreadCount) — N1
- 워크스페이스 joinMode 설정 편집(UpdateWorkspaceRequest 스키마 확장) — N5-4
- AutoMod 규칙 폼 분기 + 감사 로그 5열 DTO(target/reason) — N5-3
- 채널 권한 override 편집기 — N5-2
- Unreads 미리보기 엔드포인트 — N6-1
- DM visibility/mute/leave/group-members rate-limit(defense-in-depth) — N1 리뷰
- canSuppressEmbed fine-grained 권한 plumbing(S61) — N0 리뷰 F4
- 실시간 연결 불가 배너 + 세션 배너 — N6-3
- 아카이브 채널 사이드바 숨김/read-only enforcement — N3 리뷰

**프론트 후속(독립 슬라이스):**

- Preview Tray @dnd-kit 재정렬(N6-2) · N6-4 LOW 묶음 · axe 데스크톱 라우트 확대.

**사용자 승인 게이트:**

- D2 채팅 폰트 크기(`--fs-chat` DS 토큰 6단계) · D5 DS contrast 토큰 — DS 4파일 1회 개정.

## N6-5 D2/D5 — DS 토큰 1회 개정 (사용자 D2+D5 일괄 승인)

**서버 백로그 진행 여부**: 사용자 "지금은 보류(072 마감)" — 서버 의존 이월 항목은 다음 작업 때.

- **D2 (FR-PS-09 P0 · 채팅 폰트 크기)**:
  - `tokens.css`: `--fs-chat: var(--fs-15)` 신설(기본=본문 base).
  - `components.css`: `.qf-message__body { font-size: var(--fs-chat, var(--fs-15)) }` 으로 retarget.
  - `applyAppearanceToDOM.ts`: chatFontSize(12/13/14/15/16/18) → `--fs-chat: var(--fs-N)` 주입 재개
    (raw px 아님 · rem 토큰 참조라 WCAG 1.4.4 Resize text 준수). spec 갱신.
  - `AppearanceSettingsPage.tsx`: 폰트 슬라이더 활성화(F-M1 '준비 중' 해제) + onChatFontSize 저장. spec 갱신.
- **D5 (071-M6 이월 contrast)**:
  - `mobile.css` `.qf-m-section__action`: `color: var(--accent)`(a-500, 패널 위 <4.5:1) → `var(--link)`
    (테마-aware a-300/a-600, AA 충족). workspace-settings-save 등 잔여는 axe 게이트로 검증.

DS 4파일 수정은 D2/D5 승인 예외(다른 슬라이스는 무수정 유지). index.html 직접 link 라 데스크톱+모바일 즉시 반영.

## N6-5 적대 리뷰(wdbwcb6rl — 12 에이전트·3각도) fix-forward

raw 12 → confirmed 9. D2 가 **불완전 배선**이었음을 적발 → 전면 수리.

- **BLOCKER**: useAppearanceSettings.applyIfChanged 가 theme/density 변경 시에만 applyAppearanceToDOM
  호출 → chatFontSize-only 변경(슬라이더)이 리로드 전까지 미적용. 조건에 chatFontSize 추가.
- **HIGH×3**: --fs-chat 를 소비 안 하던 메시지 본문 클래스 전부 배선 —
  `[data-density=compact] .qf-message__body`(--fs-14→var(--fs-chat,--fs-14)) ·
  `.qf-thread-msg__body`(스레드 답글) · `.qf-m-msg__body`(모바일). 미설정 시 각 기본 폴백.
- **LOW**: a11y-mobile axe 의 .qf-m-section\_\_action 제외 해제(D5 후 6.6:1+ AA 충족 → axe 강제) ·
  applyAppearanceToDOM/AppearanceSettingsPage 의 stale '준비 중/보류' 주석 정정.
- **MEDIUM(이월)**: .qf-btn--primary(workspace-settings-save 등) a-500 bg+흰 텍스트 AA 미만 —
  전역 브랜드 버튼 색 결정이라 별도 슬라이스 이월(axe 노드 격리 유지).
