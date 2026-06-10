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
| C1   | #2 /w 채널 뷰 flex 레이아웃(컴포저 소실·상단 앵커)                           | todo |      |
| C2   | #1 시트/드로어 백드롭 z-스택(탭 차단) — 5개 컴포넌트                         | todo |      |
| C3   | #3 qf-m-screen--app 일괄 적용(62px 패딩)                                     | todo |      |
| C4   | #6 Discover 카테고리 filter-bar 교체(세로 글자)                              | todo |      |
| C5   | #7 Activity actorName + 행 탭 점프(+ MobileShell ?msg= 소비)                 | todo |      |
| C6   | #8 ToastViewport 전 모바일 화면(App 레벨)                                    | todo |      |
| C7   | #9 탭바 설정 목적지 통일 + 설정 셸 모바일 내비(back/목록)                    | todo |      |
| C8   | #5 /dm 모바일 분기 + /dms 진입점 연결                                        | todo |      |
| C9   | #10 멤버 드로어 프레즌스 구독 복구                                           | todo |      |
| C10  | #4 모바일 읽음 ACK 발송                                                      | todo |      |
| C11  | #11 lastChannel 저장/복원 + 기본 채널 폴백(FR-IA-WS-01)                      | todo |      |
| C12  | 게이트: 모바일 e2e red 수리 + CI 필수화 + vr-parity baseline 시드·fixme 해제 | todo |      |
| C13  | standalone VERIFY + reviewer 적대 리뷰 + fix-forward                         | todo |      |
| C14  | develop 머지·push 확인 → main 승격 → 배포 /readyz → REPORT                   | todo |      |

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
