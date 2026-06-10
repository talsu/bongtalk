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

## 청크 상태

(착수 시 UNDERSTAND/PLAN 후 분해 — M1 D1~D12 / M2 E1~E8 패턴을 따른다. 마지막 두
청크는 항상 게이트(e2e+verify+적대 리뷰 fix-forward)와 머지·배포·REPORT.)

## 세션 핸드오프 노트

- (착수) M2 종료(main c3b42d2 · 배포 exit 0 · readyz ok) 직후 브랜치만 생성해 둔 상태.
  다음 작업: M3 절 + 감사 ref 정독 → 청크 분해(이 문서 갱신) → 구현.
- 서브에이전트 브리프 필수 문구: "읽기 전용 — git checkout/branch 전환 금지" +
  "머지/배포/prod 접근 금지".
