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

| 청크 | 내용 | 상태 | 커밋 |
| ---- | ---- | ---- | ---- |
| N2-1 | CustomStatusModal(이모지+텍스트≤100+만료 프리셋 6종, EmojiPicker 재사용) 신설 + BottomBar '커스텀 상태 설정' 진입 + ProfileSettingsPage 편집 진입 (HIGH) | todo | |
| N2-2 | BottomBar INVISIBLE 활성화(setStatus offline, '오프라인으로 표시') + 영문→한글 라벨 + ProfilePopover dnd '방해 금지' 통일 (D1·LOW) | todo | |
| N2-G | 게이트: 데스크톱 e2e(presence) + standalone verify + 적대 리뷰 | todo | |
| N2-D | develop 머지→main 승격→배포→/readyz→REPORT | todo | |

## 이월(문서화)

- lastSeenAt(마지막 접속) 표기(FR-P10 MEDIUM) — 서버 full-profile 응답 확장 필요 → 서버 슬라이스.
- DND 반복 스케줄 편집 UI(FR-P06) — 설정 알림 탭 소관 → N5(설정) 또는 별도.
- 친구 목록 행 보조정보(FR-P01 friends) — FriendsPage 소관 → N5.
