# 072 — 데스크톱(PC) UI/UX 정합 개편

> 071 모바일 개편의 데스크톱 대응판. 감사: `docs/audits/2026-06-13-desktop-uiux-audit.md`
> (Workflow `wdov0xt9u`, 77 에이전트, 후보 85 → 확정/판단 77 · 기각 8).
> 규약·검증·배포는 071 과 동일: **GitHub push-only · 게이트는 로컬**(standalone `pnpm verify` +
> 데스크톱 e2e green) · 배포는 main 체크아웃에서 수동 `auto-deploy.sh` · 슬라이스마다 적대 리뷰 fix-forward.
> **DS 4파일(`design-system/*.css|.html`) frozen** — 전부 앱 레이어(`apps/web/src`) 채택/수리.
> 데스크톱 = `qf-*`(components.css) / 모바일 `qf-m-*` 은 071 에서 완료(범위 밖, 공유 컴포넌트는 데스크톱 경로만).

## 목표 (감사 → 수리)

PRD 데스크톱 스펙/목업 + DS 갤러리 대비 **데스크톱 표면의 결손·완성도·정합 갭**을 닫는다.
치명적 파손(BLOCKER)은 없고, 대부분 "PRD 목업/FR 이 규정한 표면이 데스크톱에 미노출/부분구현/괴리"다.
종료 시 fr-matrix 를 데스크톱 기준으로 재분류한다(메타 발견: done 341 이 데스크톱 기준 과대표기).

심각도 분포: **HIGH 11 · MEDIUM 29 · LOW 37**.

## ★착수 전 결정 필요(사용자) — 슬라이스 진입 게이트

| #   | 결정                                                                                                                            | 옵션                                                                                                                      | 영향 슬라이스 |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------- |
| D1  | **INVISIBLE(오프라인 표시) 상태** — PRD 내부 상충: FR-P01(INVISIBLE 존재·done) vs FR-PS-17(ONLINE/IDLE/DND/OFFLINE 4상태)       | (a) 활성화(setStatus offline 매핑 이미 존재) **(권장)** / (b) 항목 제거 + PRD 정정                                        | N2            |
| D2  | **채팅 폰트 크기(FR-PS-09 P0)** — DS 에 `--fs-chat` 토큰·`.qf-message__body` font-size 배선이 없음. DS 4파일 frozen 규약과 충돌 | (a) DS 토큰 1회 개정 승인(px→rem + `--fs-chat` 6단계) / (b) 보류(현행 고정)                                               | N6            |
| D3  | **WYSIWYG-lite 컴포저(FR-RC01 P0)** — 전반 textarea 채택. PRD 는 contenteditable 인라인 렌더+멘션 pill 요구                     | (a) 전면 교체(대규모·리스크 큼) / (b) 멘션 pill 만 부분 충족 / (c) 데스크톱 의도 괴리로 수용+PRD 정정 **(권장 b 또는 c)** | N0            |
| D4  | **퀵스위처 검색 소스(FR-S01 P0)** — 클라 퍼지매칭 vs 서버 `/quick-switcher` 정본                                                | (a) 현행 유지(NAS 소규모 충분) **(권장)** / (b) 서버 폴백 도입                                                            | N4            |
| D5  | **DS contrast 백로그**(071-M6 이월: `qf-m-section__action`·`workspace-settings-save` 등) — DS 토큰 개정 필요                    | D2 와 묶어 일괄 결정                                                                                                      | N6            |

## 청크/마일스톤 (N0~N6 — 071 M0~M6 동형)

각 마일스톤 = 여러 청크. 마일스톤 종료 시 게이트(데스크톱 e2e + standalone verify + 적대 리뷰
fix-forward) → develop `--no-ff`(ls-remote 실측) → main 승격 → 수동 배포 → /readyz → REPORT.

### N0 — 메시지 행·반응 표면 (공용 기반 · 선행)

후속 마일스톤이 같은 메시지행/툴바 영역을 건드리므로 최우선. 주로 FE.

- **N0-1 hover 툴바 표준화 (HIGH)**: `MessageItem` hover 툴바에 퀵 반응 3종(👍❤️😂 — `pickerQuickReactions` 앞 3개 인라인) + 피커 열기 + 답장/스레드. `qf-msg-quickreact`(components.css:1549) 채택. `미읽으로 표시` 위치 정정(D09 mock).
- **N0-2 반응 칩 hover 툴팁 (MEDIUM)**: `MessageDto.reactions` 에 `previewUsers(≤5)` 추가(★서버 DTO/계약 확장 — `ReactionSummary` 에 구조 없음) → `ReactionBar` 칩에 `.qf-tooltip`(이름 ≤5 + '외 N명').
- **N0-3 본인 멘션 하이라이트 행 (MEDIUM)**: `MessageItem` 에 `astMentionsViewer`(MobileMessages 에서 공통화) 판정 → `qf-message--mention` 배경.
- **N0-4 이모지 피커 보강 (MEDIUM×2)**: 검색 input(`filterEmojis` 재사용) + 스킨톤 선택기(6종 → `PUT /me/emoji-preferences`).
- **N0-5 스레드 루트 리치 렌더 (MEDIUM)** + **코드블록 헤더/복사(LOW)** + **embed suppress ✕(MEDIUM — D16+D11 병합, BE suppress 엔드포인트 기존)**.
- **N0-6 (D3 결정 반영)** WYSIWYG/멘션 pill — 결정 b/c 따라 부분 충족 또는 PRD 정정.

### N1 — DM 데스크톱 셸 완성 (의존: N2 프레즌스 닷)

데스크톱 DM 셸이 1:1만 지원하고 그룹 DM 경로가 통째 dormant.

- **N1-1 그룹 DM 표시 (HIGH)**: `DmShell` 에 `useDmGroupList` 배선 + 그룹 행(아바타 스택·참여자명·프리뷰·배지) 1:1 과 합쳐 `lastMessageAt` DESC.
- **N1-2 새 DM/그룹 생성 모달 (HIGH)**: 사이드바 헤더 '새 DM' 버튼 → 받는사람 멀티셀렉트(`qf-autocomplete`) → 1명=`useCreateOrGetDm`/2명+=그룹 생성.
- **N1-3 우클릭 메뉴 (HIGH)**: 숨기기(`visibility HIDDEN`)·그룹 나가기·뮤트 기간 서브메뉴(6종).
- **N1-4 DM 검색 서버 q (LOW)** + **친구 행 정합 (MEDIUM/LOW)**: `qf-m-row` 오용 수리 → 데스크톱 정본, 프레즌스 닷·'@핸들·상태' 보조행·DM/더보기 액션.

### N2 — 프레즌스·커스텀 상태 (HIGH×2 병합)

데스크톱만 커스텀 상태 편집 UI 부재(훅·서버 완비).

- **N2-1 커스텀 상태 편집 (HIGH)**: `BottomBar` presence 드롭다운에 `.qf-status-picker`(이모지+텍스트+만료 프리셋 6종) + `ProfileSettingsPage` 커스텀 상태 섹션 완성(현 DND 토글만) → `useSetCustomStatus`/`useClearCustomStatus`.
- **N2-2 INVISIBLE (D1 결정)** + **lastSeen 표기(MEDIUM)** + **라벨 한글화·DND 라벨(LOW)**.

### N3 — 채널 사이드바·CRUD·횡단 진입

- **N3-1 채널 생성 모달 (HIGH)**: 타입(텍스트/공지) 라디오 + 비공개 토글 + topic/description 필드 분리(현재 '설명' 라벨이 topic 에 바인딩).
- **N3-2 채널 아카이브 (HIGH)**: `ChannelSettingsPage` 에 아카이브/해제 토글 배선(`useArchiveChannel` 기존, 기본채널 비활성).
- **N3-3 채널 브라우저 (MEDIUM)**: 멤버수·정렬·가입/열기 분기.
- **N3-4 사이드바 정합 (LOW)**: 채널행 prefix 아이콘(lock/megaphone/#)·토픽 100자 접기·횡단 4종 고정행(검색/인박스/스레드/저장됨 — 누락표면)·저장 배지색(`qf-badge--accent`).

### N4 — 검색·단축키

- **N4-1 Jump 후 패널 유지 (HIGH · P0 · S)**: `onJump` 에서 `closeSearchPanel()` 제거 + 회귀 e2e.
- **N4-2 정렬 토글 (MEDIUM)**: `useSearch` 에 `sort` 파라미터 + 헤더 `.qf-tabs`.
- **N4-3 Ctrl/Cmd+G + placeholder (LOW)** + 포맷 단축키 PRD 정리(LOW) + (D4 결정) 퀵스위처 소스.

### N5 — 모더레이션·역할·워크스페이스·설정 (착수 전 추가 정찰)

★N5 착수 전 **누락 표면 1회 정찰**: 디스커버리(`DiscoverShell`/`DiscoverPage`)·가입 신청(`ApplicationForm`/`ApplicationPendingPage`/`ApplicationReviewPanel`)·초대 수락 랜딩(`InviteAcceptPage`/`InviteExpired`/`EmailInviteAcceptPage`).

- **N5-1 워크스페이스 아이콘 업로드 (HIGH)**: 생성 모달·설정 일반탭(presign/finalize, 5MB/512px, `avatarUpload.ts` 재사용).
- **N5-2 역할 권한 카탈로그 (MEDIUM)**: `permissionCatalog` 에 KICK/BAN/TIMEOUT 비트 + position 재정렬/표시·멤버 탭(LOW) + 채널 override 편집기(LOW, BE 동반 가능).
- **N5-3 AutoMod (MEDIUM)** + **감사 로그 5열(MEDIUM)** + **신고큐 작성자(LOW)**.
- **N5-4 워크스페이스 일반탭 이름/joinMode (MEDIUM)** + 초대 모달 옵션(LOW) + 도메인 문구 stale(LOW) + 설정 단축키/기본탭(LOW).

### N6 — 실시간·읽음·첨부·인증 + PRD/추적 동기화 + 검증 상시화

- **N6-1 Unreads 미리보기 (HIGH)**: BE `GET /workspaces/:wsId/unreads`(채널별 ≤5 + 차단 마스킹 + cursor) + `UnreadsView` 를 Mock B 카드형으로 재구성.
- **N6-2 Preview Tray 재정렬 (MEDIUM · P0)**: `@dnd-kit`(SidebarSections 선례) 드래그 핸들.
- **N6-3 연결 불가 안내(MEDIUM)** + 세션 만료/탈취 배너(MEDIUM×2, FR-AUTH-55/56).
- **N6-4 저장 원본이동(LOW)·핀 패널 메타(LOW)·저장탭 카운트(LOW)·2FA DS 채택(LOW)·배너 위계(LOW)**.
- **N6-5 (D2/D5 결정) 폰트 크기 + DS contrast** — 승인 시 DS 토큰 1회 개정.
- **N6-6 PRD/추적 동기화(docs only)**: fr-matrix 에 D18 행 추가 + done 재분류(데스크톱 기준) + stale PRD §5(비번 재설정 done)·presence:ping 폐기 문구 정정.
- **N6-7 검증 상시화**: 데스크톱 e2e 신규 커버(hover 툴바·DM 생성·커스텀 상태·검색 Jump·아카이브) + axe 데스크톱 라우트 확대(현 3라우트 → 셸/설정/모더레이션).

## Scope

- **IN**: `apps/web/src` 데스크톱 셸·features, 필요한 BE 확장(reactions previewUsers·unreads 미리보기·아이콘 업로드·일부 권한 API), PRD/fr-matrix 문서 동기화, 데스크톱 e2e/axe 게이트.
- **OUT**: 모바일(qf-m-\*, 071 완료)·음성/영상(direction pivot)·DS 4파일 직접 수정(D2/D5 승인 시 예외)·신규 대형 기능.

## Non-goals / Risks

- WYSIWYG 전면 교체(D3)는 리스크가 커 기본 비권장 — 부분 충족 또는 PRD 정정.
- 일부 HIGH(Unreads 미리보기·반응자 툴팁·아이콘 업로드)는 **BE 동반** — 슬라이스 내 BE+FE 한 묶음.
- 공유 컴포넌트(MessageItem 등) 데스크톱 수정이 모바일 회귀를 일으키지 않도록 분기 보존(071 e2e 53스펙이 가드).
- NAS kernel 4.4 자원 제약: verify 컨테이너와 무거운 워크플로우 동시 실행 금지(메모리 준수).

## 진행 노트

- (착수) 071 전체 종결(main 06d35b0) 직후 감사·계획 수립. 구현은 **사용자 승인 + D1~D5 결정 후** N0 부터.
