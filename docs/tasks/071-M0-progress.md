# 071-M0 진행 상황 (세션 핸드오프 문서)

> **이 문서가 단일 진실원**이다. 세션이 끊기면(리밋/모델 교체) 새 세션은 이 문서 + `git log
feat/071-m0-mobile-rescue` 만으로 이어받는다. 각 청크 완료 시마다 이 문서의 상태 표를 갱신하고
> 커밋에 포함할 것. 계획 전문: `docs/tasks/071-mobile-uiux-overhaul.md`(M0 표),
> 발견 근거: `docs/audits/2026-06-10-mobile-uiux-audit.md`(H-n/A-n/B-n).

## 작업 규약 (메가루프)

- 브랜치: `feat/071-m0-mobile-rescue` (develop 기점 d1d84cd). 청크마다 conventional commit +
  **즉시 `git push origin feat/071-m0-mobile-rescue`** (세션 유실 대비).
- 완료 조건: 모든 청크 done → standalone `pnpm verify` green → reviewer 서브에이전트 적대 리뷰
  (BLOCKER/HIGH는 fix-forward) → develop `--no-ff` 머지+push(ls-remote로 push 실측 확인 —
  silent drop 전례) → develop→main `--no-ff` 승격 push → webhook 자동배포 → /readyz 확인 →
  REPORT. 서브에이전트에게 머지/배포/prod 접근 금지 명시.
- 푸시 게이트가 OOM으로 실패하면 standalone VERIFY green 확인 후 `--no-verify` push (전례 메모리).

## 검증 환경 (이미 떠 있음 — 재부팅 불필요)

- 테스트 스택: `sudo docker compose -p qufox-e2e -f docker-compose.e2e-audit.yml up -d`
  (api=:43001, web(빌드본)=:45173, pg=:45432). 마이그레이션/시드/MinIO 버킷은 적용 완료 상태.
- **빠른 루프(권장)**: 호스트에서 `VITE_API_URL=http://localhost:43001 pnpm --filter @qufox/web dev`
  (5173) → e2e는
  `sudo docker run --rm --network host -v /volume2/dockers/qufox:/work -w /work/apps/web \
 -e PLAYWRIGHT_BASE_URL=http://localhost:5173 mcr.microsoft.com/playwright:v1.48.2-jammy \
 node_modules/.bin/playwright test --project=chromium e2e/mobile/<spec>`
- **최종 검증**: `sudo docker compose -p qufox-e2e -f docker-compose.e2e-audit.yml up -d --build test-web`
  후 같은 명령을 PLAYWRIGHT_BASE_URL=http://localhost:45173 로 전 모바일 스위트 실행.
- 수동 핸즈온 재현: `.tour/tour3.mjs`(hit-test 진단 포함) — 계정은 `.tour/creds.json`.

## 청크 상태 (갱신 필수)

| 청크 | 내용 (071 M0 표의 # 매핑)                                                    | 상태 | 커밋 |
| ---- | ---------------------------------------------------------------------------- | ---- | ---- |
| C1   | #2 /w 채널 뷰 flex 레이아웃(컴포저 소실·상단 앵커)                           | **done(e2e green)** |      |
| C2   | #1 시트/드로어 백드롭 z-스택(탭 차단) — 5개 컴포넌트                         | **done(e2e green)** |      |
| C3   | #3 qf-m-screen--app 일괄 적용(62px 패딩)                                     | **done(e2e green)** |      |
| C4   | #6 Discover 카테고리 filter-bar 교체(세로 글자)                              | **done(e2e green)** |      |
| C5   | #7 Activity actorName + 행 탭 점프(+ MobileShell ?ch= 해석·msg/thread 보존 — 하이라이트 소비는 M1)                 | **done(e2e green)** |      |
| C6   | #8 ToastViewport 전 모바일 화면(App 레벨)                                    | **done(e2e green)** |      |
| C7   | #9 탭바 설정 목적지 통일 + 설정 셸 모바일 내비(back/목록)                    | **done(e2e green)** |      |
| C8   | #5 /dm 모바일 분기 + /dms 진입점 연결                                        | **done(e2e green)** |      |
| C9   | #10 멤버 드로어 프레즌스 구독 복구                                           | **done(e2e green)** |      |
| C10  | #4 모바일 읽음 ACK 발송                                                      | **done(e2e green)** |      |
| C11  | #11 lastChannel 저장/복원 + 기본 채널 폴백(FR-IA-WS-01)                      | **done(e2e green)** |      |
| C12  | 게이트: 모바일 e2e red 수리 + CI 필수화 + vr-parity baseline 시드·fixme 해제 | **done** |      |
| C13  | standalone VERIFY + reviewer 적대 리뷰 + fix-forward                         | **done** |      |
| C14  | develop 머지·push 확인 → main 승격 → 배포 /readyz → REPORT                   | **done** |      |

## 결정 로그

- (2026-06-10) 내비 모델 A안 확정 — M0는 모델 중립 수리만 수행, 드로어/오버레이 구조 자체는
  M2에서 OverlappingPanels로 교체 예정. 따라서 C2는 "패널을 백드롭 자식으로" 최소 수정으로 간다
  (M2에서 어차피 대체되므로 과투자 금지).
- C5의 채널 점프는 `?msg=` 소비를 MobileShell에 추가하되, 메시지 하이라이트는 M1(jump-btn)
  범위 — M0에선 해당 채널로 라우팅만 보장.
- C7 설정 내비는 M2 '나' 탭 전까지의 임시 가교: SettingsShell 사이드바를 모바일에서 목록 화면으로
  노출(들어가면 back으로 목록 복귀) 수준. you-탭 IA는 M2.

## 세션 핸드오프 노트 (끊기기 전 마지막 상태를 여기에 추가)

- (시작 2026-06-10 오후) 브랜치 생성 직후. 다음 작업: C1부터.
- (2026-06-10 오후, Fable 5 세션 #1) C1~C11 코드 적용 완료(web/api tsc green). 추가 발견·결정:
  - 기존 모바일 e2e red 의 제2원인 = loginUI 가 구식(/w 자동 리다이렉트 대기 — task-035 이후
    랜딩은 '/'), 제3원인 = e2e 계정이 이메일 미인증이라 /w UI 게이트에 차단(S66).
    → _helpers.ts loginUI 현대화 + **E2E_TEST_HOOKS=1 전용 verify 훅 신설**
    (apps/api/src/auth/e2e-test-hooks.controller.ts, auth.module 조건 등록,
    docker-compose.test.yml/e2e-audit.yml 에 env 추가, test-api 이미지 재빌드 완료).
  - C2 는 "백드롭 자식 중첩" 대신 패널에 z-[var(--z-modal)](61) 부여 — 더 작은 diff, M2에서 대체.
  - C7 확장: /settings 정적 리다이렉트를 Layout index 로 이동(모바일은 드릴다운 목록 노출),
    콘텐츠 라우트에 back 토프바 추가, 탭바 onSettings 6곳 '/settings' 통일,
    MobileShell 홈 탭 '/' 통일(C11 lastChannel 복원과 충돌 방지).
  - C5 확장: Activity 행 탭은 desktop resolveActivityClick 재사용, 채널 점프는
    `/w/:slug?ch=<channelId>&msg=` → MobileShell 이 ch 해석 후 채널 라우트로 replace.
    친구 요청 행 → /friends (모바일 의도적 분기).
  - 검증 루프: vite dev(5173, VITE_API_URL=43001) 가동 중 (/tmp/vite-dev-071.log).
  - 다음: 핵심 e2e 4종 결과 확인 → C12(전체 모바일 스위트 + CI 필수화 + vr baseline).
- (세션 #1 계속) C12 진행 중간 상태:
  - 원조 red 3종(drawer-channels/composer-send/long-press-sheet) **모두 green** (빌드본 45173).
  - long-press 1회 실패는 login rate-limit(10/분/IP, 연속 재실행 누적)이었음 — 환경성.
    로컬 반복 실행 시 분 경계 대기 또는 단독 실행 권장.
  - loginUI 는 채널 라우트 정착(`/w/:slug/<ch>`)까지 대기하도록 재수정(C11 자동 진입과
    드로어 자동닫힘의 레이스 차단).
  - 신규 `.github/workflows/e2e-mobile.yml`(모바일 전용 게이트, migrate one-shot 포함) 추가.
    기존 e2e.yml 에도 migrate one-shot 단계 보강(CI 가 빈 DB 로 /readyz 영구 실패하던 결함).
  - 전체 모바일 스위트(빌드본) 실행 중 → 결과 triage 후 vr-parity baseline 시드 예정.
  - test-web/test-api 이미지는 현 브랜치 코드로 재빌드되어 qufox-e2e 스택에 반영됨.
- (세션 #1 계속) C12 완료: **전체 모바일 스위트 23 passed / 0 failed / 7 skipped (40.9s, 빌드본
  45173)**. vr-parity fixme 해제 + baseline 2종 시드(스크린샷 육안 확인 — 패딩 제거·컴포저 고정
  반영). 남은 skip 7 = 구식 4탭 tabbar.e2e(test.skip, M2 에서 5탭 재작성 시 대체) 등 의도적 skip.
  추가 적발·수리: ① MobileOverlay history 마커 중복(비안정 onClose deps) → back 무력화,
  ② 제스처 커밋판정 state 클로저 → ref(스와이프 답장·엣지 닫기 실기 미동작의 근원),
  ③ 퀵리액션 37×33 → qf-m-react-chip 44px(touch-target 게이트가 실위반 적발),
  ④ bootstrapWorkspace 가 자동 생성 'general' 과 충돌(undefined channelId 시드 전멸),
  ⑤ 테스트 스택 rate 한도 env 화(MESSAGE_RATE_*, LOGIN_RATE_IP_MAX — prod 기본값 불변).
  다음: C13 standalone pnpm verify(실행 중) → reviewer 적대 리뷰 → C14 머지·배포.
- (세션 #1 계속) C13 진행: standalone `pnpm verify` **green** (19/19 tasks, web unit 1816 passed,
  shared-types test 포함). reviewer 서브에이전트 적대 리뷰 실행 중 — 결과의 BLOCKER/HIGH 는
  fix-forward 후 C14(머지·배포)로.
- (세션 #1 계속) C13 적대 리뷰 결과: BLOCKER 0 · HIGH 1 · MED 4 · LOW 7, 평결 request-changes
  → 전건 fix-forward 완료:
  - H1: CI 두 워크플로우 기동 순서 재배열(데이터 서비스 → migrate one-shot → 앱 기동).
    파생 적발: docker-compose.test.yml 의 minio/mc 태그가 Docker Hub 에 존재한 적 없는
    오타(RELEASE.2024-09-09T16-17-43Z) → 실재 태그(2024-09-16T17-43-14Z)로 교정.
  - M1: MobileActivity 점프에 캐시 lookup(삭제→not-found 토스트, 미캐시만 optimistic).
  - M2: `.qf-m-screen--app` height:100dvh 를 app-layer(index.css)에서 100% 로 되돌림
    (ConnectionBanner 표시 시 탭바 클리핑 차단 · safe-area 패딩은 유지).
  - M3: 테스트 훅에 NODE_ENV=production 무조건 404(독립 2팩터). L6: P2025→404.
  - M4: 토스트 컨테이너 모바일 위치(탭바+safe-area 위, md: 종전 우하단).
  - L1: bootstrapWorkspace 채널 매핑 assert. L2: LOGIN_RATE_IP_MAX 양수 유한 가드 +
    .env.example 키 추가(+로컬 .env 동기화). L5: audit compose 헤더 정정. L4: C5 표현 정정.
  - L7 운영 규약: develop push 의 e2e-mobile run green 확인 후에만 main 승격(REPORT 에
    run 링크 첨부). L3②(X버튼 back 후 재-back 시 오버레이 재오픈)는 기존 동작 — M2 IA
    재구축에서 라우트 단일화로 자연 해소 예정(스코프 외 기록).
- (세션 #1 계속) C13 완료: verify green ×2 + 리뷰 전건 fix-forward + 전체 모바일 스위트
  **25 passed / 0 failed**(플레이크 페어 3회 green). 추가 근원 적발: 낙관적(tmp-) 행이 WS 확정
  스왑으로 detach 되는 찰나의 dispatch 가 증발하는 레이스 → 스펙 3종을 확정 행(:not(tmp))
  대기로 패치. PR 문서: docs/tasks/071-M0-PR.md. 다음: C14(develop 머지→e2e-mobile run
  green 확인→main 승격→/readyz→REPORT).
- (세션 #1 계속 · C14 CI 사가) develop push 후 e2e-mobile GHA run 연쇄 디버깅 — **GHA 로그
  열람 수단 없음(gh/PAT 부재)** 이라 다음 원격 디버깅 체계를 구축함: 스텝 분해(실패 지점을
  무인증 jobs API 의 step conclusion 으로 특정) + Diag 스텝이 `::error` 어노테이션으로 로그
  핵심을 내보냄(무인증 check-runs annotations API 로 수확, **상한 10개/스텝 주의**).
  - run 2add86f: 'Start app services' 실패 → H1 그대로(리뷰 적중).
  - run a07e62b: build/migrate green 후 up 실패 → api 가 crash 가 아니라 unhealthy 로 판명.
  - run f06d68b: 어노테이션 — api 부트가 150s 내 listen 미도달(OTel OTLP export 재시도 정황)
    → 테스트 스택 OTEL_SDK_DISABLED=true + healthcheck 예산 5분.
  - run 3b7ad0f: api 'successfully started + listening' 도달했는데 busybox wget --spider 만
    5분 내내 실패(로컬 동일 이미지는 healthy) → 프로브를 node HTTP GET(127.0.0.1)로 교체,
    차회 실패 시 Health.Log 원문 + readyz 응답 본문(컨테이너 내/러너 양측) 어노테이션 추가.
  - 현재 efe36a4 run 결과 대기. **GitHub API 무인증 60req/h — 폴링은 90s+ 간격 유지할 것**
    (30s 폴링으로 한도 소진한 전례 있음).
- (배포 방침 변경 — 사용자 통지) **webhook 자동 배포 불가 상태 → 수동 배포로 진행**:
  main 승격 후 이 레포 체크아웃을 main 에 두고 `sudo bash scripts/deploy/auto-deploy.sh`
  직접 실행(DEPLOY_SHA 없이 = 현재 체크아웃 빌드, `| tail` 금지 — exit code 직접 확인),
  rollout.sh 자동 롤백 + /readyz 확인 후 REPORT.
- (사용자 지시 · 게이트 방침 확정) **GitHub 는 push 만, CI 연동 불요** — GHA run 결과를
  게이트로 삼지 않는다(워크플로우 파일은 보존·비차단). M0 머지/승격 게이트 = 로컬
  standalone verify(19/19 ×2) + 로컬 전체 모바일 e2e(25/0) green — 이미 충족.
  → C14 를 로컬 게이트 기준으로 진행: main 승격 → 수동 auto-deploy.sh → /readyz → REPORT.

## ✅ M0 완료 (2026-06-10)

- develop 머지: 2add86f(코드) + 후속 C14 커밋들, main 승격: **7fbe25c** (--no-ff, 원격 일치 확인).
- 배포: 수동 `auto-deploy.sh` (현재 main 체크아웃 빌드) — **exit 0**, api/web smoke OK,
  rollout 헬스 게이트 통과, 롤백 미발동.
- prod 실측: `https://qufox.com/api/readyz` → {"status":"ok","checks":{"db":"ok","redis":"ok",
  "outbox":"idle"}}, qufox.com 200, qufox-api/web 컨테이너 healthy.
- 게이트(최종 방침): 로컬 standalone verify 19/19 ×2 + 로컬 전체 모바일 e2e **25 passed/0 failed**.
  GitHub 는 push-only(사용자 지시) — GHA 워크플로우는 보존되어 있으나 비차단.
- 다음 슬라이스: **M1 채팅 코어 parity** (071 문서 M1 절). 착수 시 새 feat 브랜치
  `feat/071-m1-chat-core` 권장, 검증 스택은 qufox-e2e(가동 중) 재사용.
