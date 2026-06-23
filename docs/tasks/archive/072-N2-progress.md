# 072-N2 진행 — 프레즌스·커스텀 상태 (HIGH×2 병합)

> 계획: `docs/tasks/072-desktop-uiux-overhaul.md` N2. 감사: `docs/audits/2026-06-13-desktop-uiux-audit.md`.
> 브랜치 feat/072-n2-presence-status (develop cf91873 기점). DS 4파일 frozen. 규약 071/N0/N1 동일.

## 정찰 결론

- **백엔드·훅 완비**: `useCustomStatus`/`useSetCustomStatus`/`useClearCustomStatus`(GET/PUT/DELETE
  /users/me/status, text+emoji+expiresAt+preset+timezone). `usePresenceStatus.setStatus('offline')`은
  이미 wire 'invisible' 로 PATCH(서버 허용). StatusPreset 6종(dont_clear/30m/1h/4h/today/this_week).
  DS `.qf-status-picker` 존재. EmojiPicker 재사용 가능(onSelect+onDismiss, 큐레이션 유니코드).
- **데스크톱 갭**: BottomBar presence 드롭다운이 영문 라벨 + Invisible 'disabled(곧 제공)' + 커스텀
  상태 편집 진입점 전무. ProfileSettingsPage '커스텀 상태' 섹션은 DND-동시활성 토글만(텍스트/이모지 X).
  ProfilePopover dnd 라벨 '다른 용무 중'(↔ Avatar/PresenceDot '방해 금지' 불일치).
- **lastSeenAt**: 서버 full-profile 응답에 미포함 → N2 OUT(서버 슬라이스 필요), 노트만.

## 청크

| 청크 | 내용                                                                                                                                                     | 상태  | 커밋          |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------- |
| N2-1 | CustomStatusModal(이모지+텍스트≤100+만료 프리셋 6종, EmojiPicker 재사용) 신설 + BottomBar '커스텀 상태 설정' 진입 + ProfileSettingsPage 편집 진입 (HIGH) | green | d16ed8c       |
| N2-2 | BottomBar INVISIBLE 활성화(setStatus offline, '오프라인으로 표시') + 영문→한글 라벨 + ProfilePopover dnd '방해 금지' 통일 (D1·LOW)                       | green | d16ed8c       |
| N2-G | 게이트: 데스크톱 e2e(presence) + standalone verify + 적대 리뷰(wdz0d97s8)                                                                                | green | (fix-forward) |
| N2-D | develop 머지→main 승격→배포→/readyz→REPORT                                                                                                               | todo  |               |

## N2-G 적대 리뷰(wdz0d97s8 — 17 에이전트·4각도) fix-forward

raw 12 → confirmed 10 / plausible 1.

**수리 완료:**

- **HIGH**: 모달 init useEffect 가 current 변경마다 재초기화 → refetchOnWindowFocus 시 편집 중
  입력 덮어씀. dirtyRef 가드로 '열림 전환 + pristine 일 때만' 재반영(편집 시작 후 무덮어쓰기,
  단 current 늦게 도착 시 채움). 회귀 단위테스트 추가.
- **HIGH**: EmojiPicker 열린 상태 Esc 가 Dialog 까지 닫음 → 편집 폐기. 모달 onKeyDown 에서
  emojiOpen 중 Esc 는 stopPropagation + 피커만 닫고 포커스 복귀(피커 닫혀있으면 Dialog Esc 보존).
- **MEDIUM**: 트리거 aria-label 에 커스텀 상태 반영 · 이모지 버튼 aria-haspopup/aria-controls ·
  피커 닫힘 시 트리거로 포커스 복귀 · 만료 미변경 시 기존 expiresAt 보존(텍스트만 수정해도 만료 유지).
- **LOW**: BottomBar home-status 가 프레즌스 라벨 **+** 커스텀 상태 동시 노출(프레즌스 텍스트 소실 방지) ·
  EmojiPicker 커스텀 토큰(':slug:') 방어 필터.

**이월(문서화):**

- 이모지 토글 버튼 double-toggle(클릭으로 닫으면 재오픈) — MessageComposer 기존 패턴과 동일(LOW) → 노트.
- presence 드롭다운 항목의 현재 상태 AT 미노출(menuitem aria-checked 부재) — RadioGroup 전환은
  presence-toggle e2e 영향 우려로 보류 → N5/별도.
- 커스텀 상태 만료 후 표시 갱신(useCustomStatus refetchInterval 부재 — 서버는 GET 시 lazy clear) →
  폴링/타이머 추가는 폴리시 항목 → 노트.

## 이월(문서화)

- lastSeenAt(마지막 접속) 표기(FR-P10 MEDIUM) — 서버 full-profile 응답 확장 필요 → 서버 슬라이스.
- DND 반복 스케줄 편집 UI(FR-P06) — 설정 알림 탭 소관 → N5(설정) 또는 별도.
- 친구 목록 행 보조정보(FR-P01 friends) — FriendsPage 소관 → N5.
