# 071-M3 진행 상황 (세션 핸드오프 문서)

> 단일 진실원. 계획 전문: `docs/tasks/071-mobile-uiux-overhaul.md` M3 절,
> 감사 근거: `docs/audits/2026-06-10-mobile-uiux-audit.md`. 규약·검증·배포는 M0~M2 와 동일 —
> **GitHub push-only, 게이트는 로컬**(standalone `pnpm verify` + `e2e/mobile` green),
> 배포는 main 체크아웃에서 수동 `sudo DEPLOY_PUSHER=... bash scripts/deploy/auto-deploy.sh`.
> 검증 스택 `qufox-e2e`(api :43001/web :45173) — 코드 변경 후 test-web(/api) `up -d --build`.
> 브랜치: feat/071-m3-reachability (develop 8e70a82 기점).

## 범위 (071 M3 절 — 도달성: 모바일에서 막힌 기능 진입점 일괄)

저장함·핀 목록 화면, 초대 생성/관리·멤버 디렉터리, 신고 큐/감사 로그(`/w/:slug/settings`
채널명 오해석 라우팅 충돌 해소), 모더레이션 액션(프로필 시트), 채널 알림 설정/뮤트(채널
롱프레스 시트), 편집 이력 보기, 슬로우모드 쿨다운 표시, 전체 프로필 시트(MemberProfilePanel
모바일 변형), 빈 채널 CTA·권한 없음·410 상태 화면, '모두 읽음'+Undo, 멤버 목록 hoist 그룹/
페이지네이션, 워크스페이스 생성 모달 풀스크린화.
감사 ref: A(6·7·8·12·13·14·15), B(1·3·4·5·9·14·15·18·19·20·21·26·27·29·35·39), H-11.

## M2 이월(이 슬라이스에 포함)

- 서버 메뉴 시트 확장(server-header 탭 → 초대/설정/채널 생성 진입).
- 채널 생성 모달 모바일 변형(ChannelBrowser onCreateChannel 연결).
- 스레드 탭 '모두 읽음'(useMarkAllThreadsRead — ThreadsView 패턴).
- dm-chat e2e 포팅(skip 해제 — 레일 DM 슬롯 경로).
- 스레드 탭→?thread= 풀체인·검색→?msg= 풀체인·로그아웃 confirm e2e.
- aria-hidden 패널 inert 처리(키보드 포커스 차단).
- 멘션 백필(M1 이월): contentRaw `@{uuid}`/`<#uuid>` 패턴 행 한정 재파싱(reversible,
  api 1회성 태스크).
- emoji customId Cuid2Schema → uuid|cuid2 확장(shared-types 소절).

## 청크 상태 (UNDERSTAND 워크플로우 12-agent 정찰 + 완전성 비평 반영)

| 청크 | 내용                                                                                                                                                                                              | 상태 | 커밋 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---- |
| F1   | 기반: /w/:slug/settings 라우팅 분기(+lastChannel effect 가드 한 커밋)+MobileWorkspaceSettings 드릴다운+공용 시트 back 마커 훅+MobilePanels inert+api.ts retryAfter 전달+용도별 권한 게이트 분리   | todo |      |
| F2   | 서버 메뉴 시트(MobileServerMenuSheet): 멤버/둘러보기/채널·카테고리 생성/초대 생성·관리/디렉터리/설정/나가기 — CreateChannelModal·CreateInviteModal·InviteManagerPanel·MemberDirectoryPanel 재사용 | todo |      |
| F3   | 저장함('나' 탭 행+/saved 라우트+SavedView 재사용)+핀 목록(topbar 핀 버튼+MobilePinList+?msg= 점프)                                                                                                | todo |      |
| F4   | '모두 읽음'+Undo(좌패널 섹션 액션, useMarkAllRead 복제)+스레드 탭 모두 읽음+touch-target 보강                                                                                                     | todo |      |
| F5   | 채널 롱프레스 시트(MobileChannelSheet): 뮤트 6종/해제+알림 설정, Link click suppress, useMutedChannelIds 행 표시/배지 억제                                                                        | todo |      |
| F6   | 편집 이력(EditHistoryBody 추출+시트)+슬로우모드 쿨다운(useSlowmodeCooldown 공유 훅+컴포저 표시)                                                                                                   | todo |      |
| F7   | 상태 화면: 빈 채널 CTA+history.isError 분기(errorCode 기준 403/404/재시도)+워크스페이스 생성 모바일                                                                                               | todo |      |
| F8   | 멤버 우패널 업그레이드(useMemberGroups — hoist+4버킷·B-119 idle·B-109 역할 한글화)+풀 프로필 시트(ProfileBody 추출)+모더레이션 액션                                                               | todo |      |
| F9   | 신고 큐/감사 로그: MobileWorkspaceSettings 행 → ReportQueuePanel/AuditLogPanel 재사용                                                                                                             | todo |      |
| F10  | (api) 멘션 백필 BullMQ 1회성 잡(raw SQL 배치·백업·멱등)+emoji customId uuid 확장(shared-types 범프)                                                                                               | todo |      |
| F11  | 게이트: e2e(dm-chat 포팅·스레드/검색 풀체인·로그아웃·신규 표면)+standalone verify+적대 리뷰 fix-forward                                                                                           | todo |      |
| F12  | develop 머지(ls-remote)→main 승격→수동 배포→/readyz→REPORT                                                                                                                                        | todo |      |

## 정찰 핵심(충돌 조율 — CRITIC 반영)

- **rest[0]==='settings' 분기는 F1 단독 소유**(F2/F9 는 소비만). lastChannel 자동복원
  effect 의 inWorkspaceSettings early-return 가드와 **반드시 한 커밋**(★튕김 함정).
- **권한 게이트 3종 분리**: canModerate(OWNER|ADMIN|MODERATOR)/canManageWorkspace
  (OWNER|ADMIN)/초대 게이트는 데스크톱 정본 확인 후 — MobileShell 현 canManage 는
  MODERATOR 누락(사전존재 버그 의심, 데스크톱 Shell 은 포함).
- **공용 시트 back 마커 훅**을 F1 에서 추출, F2/F5/F8 시트 전부 사용(MobilePanels
  마커와 꼬임 방지).
- api.ts bubbleError 의 retryAfterSec/Ms 전달은 F1 선행(F6 슬로우모드 의존, 전 에러
  공통 경로 — 회귀 주의).
- 채널 행 롱프레스: ChannelRow 가 Link 라 **합성 click suppress 필수**(+
  -webkit-touch-callout). PANEL_EDGE_PX 양보 동일 적용.
- 백필: TS 재파싱 러너 선례 없음 — **BullMQ 1회성 잡**(onModuleInit 고정 jobId+Redis
  완료 마커, 배포만으로 실행 — Safe Autonomy 정합). raw SQL 로 contentAst/contentPlain
  만 갱신(updatedAt/version/editedAt 불변), 구값 백업 테이블 적재(reversible).
- 보류 기록: 저장 항목→원본 점프(SavedMessageDto 에 ws 컨텍스트 부재 — API 확장 필요,
  데스크톱에도 없는 기능), lastSeen 표기(스키마 부재), 채널 NotifLevel 라디오(전 플랫폼
  신규 표면 — 뮤트 우선), 스레드 read-all Undo(서버 스냅샷 부재 — 데스크톱 parity 토스트만).
- 사전존재 버그 의심(F11 리뷰에서 판단): MobileSearchTab 2자 placeholder vs
  isSearchQueryAllowed 3자 게이트 모순.

## 세션 진행 노트 (M3)

- F1 완료(32d1c1a) — settings 분기+가드(★튕김 함정), WorkspaceSettingsOverlayHost
  직마운트(신고/감사 탭 내장 — F9 흡수), useSheetHistoryMarker, MobilePanels inert,
  api.ts retryAfter, canManageWorkspace/canModerate 분리. 프로브: settings 직진입
  유지/신고 탭/ReportQueuePanel green(감사 탭 testid 는 ws-settings-tab-audit-log).
- F2 완료 — MobileServerMenuSheet(7항목+나가기 2-step), server-header 트리거 버튼화,
  CreateChannel/CreateCategory/CreateInvite 모달 + InviteManager/MemberDirectory
  오버레이 배선, ChannelBrowser onCreateChannel 연결(M2 이월 해소).
  ★레이스 적발·봉인: 좌패널 열림 상태에서 시트 동시 오픈 시 MobilePanels back
  마커 소거(history.back)가 시트 마커를 pop → 시트 즉시 닫힘. **openSheetFromPanel
  헬퍼(패널 닫기 → 80ms 후 시트 오픈)** 로 봉인 — F5 채널 롱프레스 시트도 필수 사용.
  비고: 패널 열림 중 ESC 는 패널을 닫지 않음(터치 전용 — 스크림이 클릭 가로챔).
  프로브 green: OWNER 7항목/MEMBER 관리 숨김/채널 생성 관통(briefing 행)/디렉터리
  오버레이/나가기 armed→실탈퇴.

## 세션 핸드오프 노트

- (착수) M2 종료(main c3b42d2 · 배포 exit 0 · readyz ok) 직후 브랜치만 생성해 둔 상태.
  다음 작업: M3 절 + 감사 ref 정독 → 청크 분해(이 문서 갱신) → 구현.
- 서브에이전트 브리프 필수 문구: "읽기 전용 — git checkout/branch 전환 금지" +
  "머지/배포/prod 접근 금지".
