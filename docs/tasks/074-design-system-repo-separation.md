# 074 · DS 별도 프로젝트(`../design-qufox`) 분리 + 부트스트랩 + 핸드오프

> 상태: DRAFT (계획 검토 대기)
> 작성: 2026-06-16
> 선행: [[073-design-system-showcase-site]] 의 design.qufox.com 쇼케이스 + 이중청중 원칙을 흡수
> 동기: **거버넌스/규칙 격리** — qufox의 무거운 채팅앱 규칙·파이프라인이 DS 작업의 짐이 되거나
> DS 의도를 변질시키는 것을 방지(사용자 명시).

---

## Context & 결정 근거

별도 repo 분리를 적대적으로 검증한 결과(3-에이전트 워크플로우):

- **분리는 타당**하고 사용자의 "참조 방식"이면 SSOT 원칙 유지됨. 거버넌스 격리는 분리를
  정당화하는 **가장 강한** 동기(기술적 결합보다 강함 — 격리 압박은 074를 기다려주지 않음).
- 그러나 현재 결합은 **깊고 living**: `tailwind.config.js`가 토큰 ~20개를 `var(--*)`로 직접
  배선, `apps/web/src` 220개 파일이 `qf-*`/토큰 참조(`var(--*)` 1,413회), `index.html`·
  `Icon.tsx`·e2e 비주얼 baseline이 `/design-system/*` 경로 의존, DS+앱이 같은 커밋에서
  원자적 변경(072-N6-5, D2), 소비자 1개(packages/ui는 110바이트 stub), 074 범용/채팅
  모듈화 미완.
- 따라서 **"전부 이동 + npm 발행 + 버전 핀"식 분리는 거부** — (a) 정리 안 된 60/40 split을
  영구 repo 경계로 화석화, (b) living DS가 버전 핀 뒤에서 죽음, (c) NAS 파이프라인(이미 취약:
  develop push silent-drop, combined verify OOM, webhook stdin orphan hang)에 cross-repo
  의존이라는 새 실패 표면 추가.

### 채택 모델 — "Vendored-SSOT 분리"

```
┌─ ../design-qufox  (신규 repo, /volume2/dockers/design-qufox)  ── 진실의 원천(SSOT)
│   • tokens/ 원본(JSON) → packages/tokens/dist (CSS·JS·tailwind preset·tokens.json)
│   • packages/css (components/mobile/docs/icons.css + icons.svg)
│   • packages/manifest (components.json — AI/사람 공용 카탈로그 데이터)
│   • apps/docs (카탈로그 사이트) → design.qufox.com
│   • 자체 린 CLAUDE.md / .claude / 메모리 / llms.txt / AGENTS.md (채팅앱 baggage 0)
│
└─ qufox/apps/web/public/design-system/*.css  ── 빌드 산출물의 "벤더 사본"(커밋됨)
    • 경로·내용 형태 = 현행과 동일 → index.html·tailwind·Icon.tsx·Dockerfile·e2e 무수정
    • dev: ../design-qufox 빌드물 심링크(즉시 반영) / prod: 커밋된 벤더 사본 사용
    • sync 스크립트 + 토큰 계약 테스트로 drift 차단
```

원칙: **DS는 design-qufox에서 authoring, qufox는 빌드 산출물을 벤더링해 소비.**
npm 발행·버전 핀·레지스트리는 **2번째 실제 소비자가 생길 때까지 OUT**. 이로써 규칙 격리는
즉시 얻고, 런타임 결합 절단·버전 핀의 비용은 지불하지 않는다.

---

## Goal

`../design-qufox` 를 자체 린 규칙을 가진 독립 DS repo로 셋업하고, 새 Claude 인스턴스가 그
repo에서 바로 DS 작업(범용/채팅 분리·고도화)을 이어갈 수 있도록 부트스트랩 파일까지 갖춰
핸드오프한다. qufox는 빌드 산출물을 같은 경로에 벤더링해 **무중단**으로 계속 동작한다.

---

## Scope

### IN

1. **신규 repo 셋업** (`/volume2/dockers/design-qufox`, git init, 자체 remote)

   - pnpm + Turborepo 린 구조(tokens → css → manifest → docs 4축).
   - 디렉터리 레이아웃은 아래 "Repo 구조" 참조.

2. **부트스트랩 파일 세트** (아래 표) — 새 Claude가 즉시 작업 가능하도록.

   - 자체 `CLAUDE.md`(린), `.claude/settings.json`, `.claude/agents/`(5개), 메모리 시드,
     `README.md`, `llms.txt`, `AGENTS.md`, `package.json`, 환경 핀 파일.

3. **DS 소스 이관** (framework-agnostic 레이어만)

   - 이동: `tokens.css`·`components.css`·`mobile.css`·`docs.css`·`icons.css`·`icons.svg`·
     카탈로그 `index.html`·`brand-assets/`(브랜드 레이어).
   - **잔류(qufox)**: React 소비 글루 `src/design-system/primitives/Icon.tsx`,
     `brand/BrandMark.tsx`, `tokens/*.ts`(JS측 미러) — 이건 앱의 소비 어댑터. (향후 React
     컴포넌트 패키지를 원하면 별도 Phase.)
   - 1회성 `scripts/sync-from-app.sh` 로 이관 후 design-qufox가 SSOT.

4. **qufox 소비 메커니즘 (벤더링)**

   - design-qufox 빌드 산출물(`packages/tokens/dist` + `packages/css`)을 qufox
     `apps/web/public/design-system/*.css` 로 sync 하는 스크립트(`scripts/sync-design-system.sh`).
   - dev: 심링크(즉시 반영) 옵션. prod: 커밋된 벤더 사본(Dockerfile·배포 무수정).
   - **토큰 계약 테스트**: 앱이 `var()`로 소비하는 토큰 전수 vs design-qufox export 토큰
     집합 대조 → 누락 시 verify 실패로 승격(현재 CSS var 미정의는 silent → prod 흰화면 방지).

5. **카탈로그 사이트 + design.qufox.com**

   - 현 `design-system/index.html` 후계를 design-qufox `apps/docs` 로 이관, 이중청천 원칙
     적용(073의 `llms.txt`/AI 진입 가이드 흡수). 호스팅은 073의 nginx 절차(Option A static
     root, tetris 선례) 재사용하되 served 콘텐츠 소스가 design-qufox 빌드물.

6. **핸드오프**

   - 새 repo 첫 작업 = 074-follow(범용/채팅 분리)를 design-qufox 안에서 시작하도록 task 시드
     - 핸드오프 프롬프트(REPORT 단계 포함, 메모리 `feedback_handoff_must_include_report` 준수).

7. **AI 소비 2채널 구성** (아래 "AI 소비 2채널" 절 — 사용자 명시 요구)
   - canonical 산출물(`tokens.json`·`components.json`·CSS·`llms.txt`/`llms-full.txt`)을 **Web(안정
     URL + CORS)** 과 **Local(예측 가능 경로 + 커밋된 dist)** 양쪽에 동등 노출.
   - 두 채널 byte-identical 보장 + drift 방지 일관성 체크. "새 APP 반영 5단계"를 양 채널 동일 문구로.

### OUT

- npm publish / 사내 레지스트리(Verdaccio) / 버전 핀 — **2번째 실제 소비자 생길 때까지**.
- 범용/채팅 CSS 분리의 **완료** — design-qufox 안에서 점진(이 문서는 셋업까지).
- React 컴포넌트 패키지화, MCP 서버, Figma Tokens Studio 왕복 — 후순위(형식만 호환 유지).
- qufox의 소비 경로 변경 — **의도적으로 안 건드림**(벤더링으로 무수정 유지).
- qufox 배포 파이프라인(webhook/auto-deploy) 편입 — 분리 유지.

---

## Repo 구조 (`../design-qufox`)

```
design-qufox/
├─ CLAUDE.md  AGENTS.md  README.md  llms.txt
├─ package.json  pnpm-workspace.yaml  turbo.json
├─ .nvmrc  .npmrc  tsconfig.base.json  eslint.config.js  .prettierrc  .gitignore
├─ .changeset/                      # (나중) 경량 릴리스
├─ .claude/
│  ├─ settings.json                 # permission 화이트리스트(NAS·DS scope)
│  └─ agents/  (ds-token-author, ds-component-author, a11y-auditor, reviewer[, visual-regression])
├─ docs/tasks/  docs/adr/           # 경량 task 계약 + 디자인 의사결정 기록
├─ tokens/                          # ★원본(SSOT): core/ semantic/ mobile/ ($metadata,$themes 나중)
├─ packages/
│  ├─ tokens/    (@qufox/design-tokens — Style Dictionary 빌드 → dist: css/js/preset/json/d.ts)
│  ├─ css/       (@qufox/design-css — components/mobile/docs/icons.css + icons.svg)
│  └─ manifest/  (@qufox/design-manifest — components.json: AI/사람 공용 카탈로그)
├─ apps/docs/                       # 카탈로그 사이트(현 index.html 후계) → design.qufox.com
├─ examples/                        # vanilla-link / tailwind-preset / react-snippet
└─ scripts/                         # build-tokens, verify, contrast-check, sync-from-app(1회성)
```

핵심: `tokens/`(JSON 원본) → `packages/tokens/dist`(산출물) → qufox 벤더 사본. 단일 조직이므로
패키지 수는 tokens/css/manifest 3개로 최소 유지(과분할 금지).

---

## 부트스트랩 파일 세트

| 파일                                                                                           | 목적                                                                                                                                        | 시점  |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `CLAUDE.md`                                                                                    | 이 repo 전용 **린 규칙** (아래 "CLAUDE.md 방침")                                                                                            | now   |
| `AGENTS.md`                                                                                    | 도구중립 에이전트 가이드(CLAUDE.md 요약 미러, 비-Claude 에이전트 대응)                                                                      | now   |
| `README.md`                                                                                    | 사람 진입점: 미션·quickstart·소비법·repo 지도                                                                                               | now   |
| `llms.txt`                                                                                     | AI 진입 인덱스(토큰 원본/dist/manifest/컨벤션/examples 링크 맵)                                                                             | now   |
| `package.json` / `pnpm-workspace.yaml` / `turbo.json`                                          | 워크스페이스 + 빌드 그래프(tokens 선행)                                                                                                     | now   |
| `.nvmrc` / `.npmrc` / `tsconfig.base.json` / `eslint.config.js` / `.prettierrc` / `.gitignore` | 결정적 환경(qufox 핀·prettier-only 관행 계승)                                                                                               | now   |
| `.claude/settings.json`                                                                        | permission 화이트리스트(Bash: pnpm/turbo/git/node; fs: repo root). prod-DB·deploy·결제 권한 **없음**, main force push·history 재작성 금지만 | now   |
| `.claude/agents/ds-token-author.md`                                                            | `tokens/*.json` 원본 편집·Style Dictionary 빌드·대비 검증(raw hex는 core 레이어만)                                                          | now   |
| `.claude/agents/ds-component-author.md`                                                        | `packages/css`의 `qf-*`/`qf-m-*` 작성(`var(--token)`만), manifest 동기                                                                      | now   |
| `.claude/agents/a11y-auditor.md`                                                               | axe + 대비 AA 4.5:1(채팅 surface 언급 제거한 계승본)                                                                                        | now   |
| `.claude/agents/reviewer.md`                                                                   | 적대적 재독(raw 값 누출·토큰 우회·a11y 회귀·manifest 누락 = BLOCKER). 머지/배포 권한 없음                                                   | now   |
| `.claude/agents/visual-regression.md`                                                          | docs surface 스냅샷 diff(Docker-isolated Playwright)                                                                                        | later |
| 메모리 시드 3종                                                                                | `project_designsystem.md`(정체성) / `feedback_ds_lean_rules.md`(버린 baggage 목록) / `reference_token_pipeline.md`(빌드)                    | now   |
| `.changeset/config.json` / `LICENSE` / `tokens/$metadata.json`                                 | 경량 릴리스·라이선스·DTCG 메타                                                                                                              | later |

---

## CLAUDE.md 방침 (격리의 핵심)

독립 `CLAUDE.md`는 현 qufox `CLAUDE.md`(229줄)의 ~90%를 버리고 DS에 직접 닿는 규칙만 남긴
**~60줄 린 문서**. 한 줄이라도 "왜 이 규칙이 DS에 필요한가" 자문을 통과 못 하면 넣지 않는다.

**계승(DS에서도 유효):**

- DS=SSOT, 단 재정의: "`tokens/*.json` 원본이 진리, dist CSS는 산출물, 손으로 dist 편집 금지".
- raw hex/px/rgba/box-shadow 금지, 예외 재정의: `tokens/core/*.json`만 raw 허용, 그 외 전부 `var(--token)`.
- 폴라이트 한국어(~합니다/~세요), UI/문서 한국어 컨벤션(읽지 않음, middot→comma).
- a11y: axe 노드격리 + 대비 AA 4.5:1(협상 불가), 44px 터치타겟.
- 토큰 우선 5단계 워크플로우, TS strict, ESLint flat+Prettier, Conventional Commits, gitleaks.
- 경량 Agent Loop(UNDERSTAND→PLAN→IMPLEMENT→VERIFY→REVIEW→REPORT), Docker-isolated Playwright,
  kernel4.4 동시실행 회피(NAS 물리 제약 reference).

**버림(채팅앱 baggage·변질 위험):**

- PRD 메가루프·parity·299FR·feature-benchmarker/competitive-capture.
- 채팅 도메인 전체(auth/workspace/channel/message/presence/WS/Redis/Prisma/Postgres/MinIO/BullMQ).
- voice/WebRTC, 배포 파이프라인(auto-deploy/webhook/flock/rollout/readyz/009/DEPLOY_SHA),
  prod-DB/시크릿/결제 가드(대상 부재), 무거운 harness 명령(bootstrap=db·debug:dump·eval/soak/SLO·smoke).
- 18개 subagent 팀 → DS 필수 5개로 감축, CodeQL/Trivy/ZAP/SBOM 야간 보안 → gitleaks/Dependabot만,
  Non-functional(P95/WS10k/idempotency/rate-limit) 삭제.

---

## 소비 메커니즘 & 가드레일

- **벤더링(채택)**: design-qufox 빌드물 → qufox `apps/web/public/design-system/*.css` 커밋된 사본.
  qufox 소비 경로·Dockerfile·배포 무수정. dev 심링크로 즉시 반영, prod 벤더 사본.
- **거부**: npm publish + 버전 핀(소비자 1개 over-engineering + living 박탈), git submodule(개발자
  체크아웃 마찰), build-time CDN fetch(NAS-only 위배·빌드 hang 위험).
- **가드레일**:
  1. 토큰 계약 테스트(앱 소비 토큰 vs DS export 토큰 대조, 누락=빌드 실패) — 양쪽 verify에.
  2. sync 검증(qufox 벤더 사본이 design-qufox 최신 빌드와 일치하는지 CI/verify 체크).
  3. 롤백 플랜(아래) 문서화 — 분리의 전제조건.
  4. DS+앱 원자 변경 시 paired 작업 명시(reviewer가 양쪽 diff 한 컨텍스트에서 검토).

---

## AI 소비 2채널 (Web + Local) — 단일 SSOT, 동등 보장

이 DS는 AI가 **두 경로** 어디로 접근해도 동일한 결과를 얻도록 구성한다. 두 채널은 같은
canonical 산출물을 가리키는 **단일 SSOT의 두 렌더링**일 뿐이며, 한쪽만 최신이 되는 drift를
구조적으로 차단한다.

**Canonical 산출물 (두 채널 모두 이걸 노출):**

- `tokens.json` (DTCG) — 토큰 값의 기계가독 정본
- `components.json` — 컴포넌트 매니페스트(클래스명·layer·variants·requiredTokens·a11y·exampleHtml)
- `tokens.css` / `*.dark|light.css`, `components.css`, `mobile.css`, `docs.css`, `icons.css` + `icons.svg`
- `tailwind-preset.cjs` — tailwind 소비자용
- `llms.txt` — 진입 인덱스 / `llms-full.txt` — 전체를 한 파일로 인라인한 확장본(1회 fetch로 전체 컨텍스트)
- `AGENTS.md` / `README.md` / `examples/` — 적용 가이드 + 복붙 예제

### 채널 1 — Web (`design.qufox.com`)

AI가 도메인만 알면 파악 가능하도록:

- **발견 진입점**: `https://design.qufox.com/llms.txt` (+ `/llms-full.txt`) — 표준 root 위치.
- **안정 URL로 canonical 직접 서빙**: `/tokens.json`, `/components.json`, `/css/*.css`, `/icons.svg`,
  `/tailwind-preset.cjs`. URL 스킴은 `llms.txt`에 명시, 변경 시 redirect 유지.
- **CORS**: JSON/CSS 응답에 `Access-Control-Allow-Origin: *` (브라우저 기반 에이전트 cross-origin fetch 허용).
- **HTML 파싱 가능**: 카탈로그는 시맨틱 마크업 + 토큰/클래스명을 **텍스트**로 노출(이미지 only 금지).
- **완전 공개**(인증 게이트 없음 — 073 결정), `robots.txt`는 크롤 허용.

### 채널 2 — Local (clone / download)

AI가 클론·다운로드한 repo만 보고 파악 가능하도록:

- **repo root**: `CLAUDE.md`(Claude) + `AGENTS.md`(도구중립) + `llms.txt`(repo-상대경로 인덱스) + `README.md`.
- **동일 canonical을 예측 가능 경로에**: `packages/tokens/dist/{tokens.json,tokens.css}`,
  `packages/manifest/components.json`, `packages/css/*.css` + `icons.svg`, `examples/`.
- 클론 직후 추가 빌드 없이도 `dist`가 존재하도록 **빌드 산출물을 커밋**(벤더 정책과 일치) → 오프라인 파악 가능.

### 동등 보장 (drift 방지)

- web `apps/docs`는 `packages/*/dist`의 **같은 파일**을 서빙 → web·local 산출물 byte-identical.
- `llms.txt`/`llms-full.txt`의 web 변형(절대 URL)은 canonical(상대경로)에서 **빌드가 경로→URL 재작성**으로 생성.
- 일관성 체크(verify): `design.qufox.com/components.json` == repo `packages/manifest/components.json`,
  `llms.txt`의 모든 링크 200/존재.
- **"AI가 새 APP에 DS 반영하는 법"을 두 채널에 동일 문구로**(AGENTS.md + llms.txt): ① `tokens.css` +
  `components.css` link 또는 `tailwind-preset` 적용 → ② `qf-*` 클래스 / `var(--token)` 사용 → ③ raw
  hex/px 금지 → ④ `examples/` 참조 → ⑤ `components.json`에서 컴포넌트 인터페이스 조회.

---

## Migration (qufox 무중단)

1. design-qufox repo 생성 + 부트스트랩 파일 + 빌드 파이프라인 green.
2. DS 소스 이관(`sync-from-app.sh`), design-qufox에서 빌드 → dist 생성.
3. design-qufox dist → qufox `public/design-system/*.css` 벤더 sync, **byte-diff 0 확인**
   (이관 직후 qufox는 시각적으로 완전 동일해야 함).
4. qufox에 토큰 계약 테스트 + sync 검증 추가, `pnpm verify` + e2e 비주얼 baseline green
   (변경 0이므로 baseline 재캡처 불필요).
5. 이후 DS 변경은 design-qufox에서 → sync → qufox PR(벤더 사본 갱신).

---

## Acceptance Criteria (기계 검증)

1. `/volume2/dockers/design-qufox` git repo 존재 + `pnpm install && pnpm build` green(tokens→dist).
2. 부트스트랩 파일 전부 존재(위 표 "now" 항목) — 파일 목록 체크.
3. design-qufox `CLAUDE.md`에 채팅앱 baggage 키워드(webhook/BullMQ/PRD/parity/WebRTC) 부재 — grep 0.
4. 이관 직후 qufox `public/design-system/*.css` 가 이관 전과 byte-identical(또는 빌드 정규화 후 시각 동일) — `pnpm verify` + e2e visual baseline **무회귀**.
5. 토큰 계약 테스트 존재 + green(앱 소비 토큰 ⊆ DS export 토큰).
6. design-qufox `pnpm verify` green(자체 lint/typecheck/contrast-check).
7. `llms.txt` + `components.json` 존재, AI가 fetch/parse 가능(토큰 카테고리·클래스 규약 포함 grep).
8. 핸드오프 프롬프트 + 새 repo `docs/tasks/001-*.md`(범용/채팅 분리 시드) 작성.
9. 롤백 플랜 문서화(design-qufox → qufox 복귀 절차).
10. **AI 채널-Web**: `curl -sS https://design.qufox.com/{llms.txt,llms-full.txt,tokens.json,components.json}` 모두 200, JSON valid parse, JSON/CSS 응답에 `access-control-allow-origin` 헤더 존재, `llms.txt` 링크 전부 도달.
11. **AI 채널-Local**: clone 직후 repo root에 `llms.txt`/`AGENTS.md`/`CLAUDE.md`/`README.md` 존재, `packages/tokens/dist/tokens.json` + `packages/manifest/components.json` 추가 빌드 없이 parse 가능.
12. **동등성**: web `components.json` == local `packages/manifest/components.json` (byte-identical), web `tokens.json` == local `tokens.json`. "새 APP 반영 5단계"가 AGENTS.md·llms.txt(양 채널) 동일 문구로 존재(grep).

---

## Risks & Rollback

- **R1 토큰 이름 드리프트**: DS가 토큰명 변경 시 qufox 런타임 silent 깨짐(흰화면) → 토큰 계약
  테스트로 빌드 타임 차단(가드레일 1).
- **R2 sync 누락**: design-qufox 변경이 qufox에 반영 안 됨 → sync 검증 + dev 심링크.
- **R3 화석화**: 범용/채팅 split 미완 상태로 이관 → 채팅 40%는 design-qufox `chat/` 레이어로
  **명시적 분리 표식**만 달고 이관(나중 repatriate 용이), 또는 qufox 잔류 결정은 follow-up.
- **R4 living 약화**: 벤더 사본이 stale → dev 심링크 + sync stale 알람(N일).
- **롤백**: design-qufox 실험 실패 시 — qufox `public/design-system/*.css` 벤더 사본이 그대로
  남아 있어 qufox는 즉시 자립(편집을 다시 in-place로). design-qufox는 archive. 30일 내 복귀 가능.

---

## 핸드오프 프롬프트 (새 repo의 Claude에게)

> design-qufox repo의 CLAUDE.md/AGENTS.md/llms.txt를 먼저 읽으세요. 이 repo는 qufox에서
> 분리된 **사람+AI 공용 디자인 시스템**의 SSOT입니다. 첫 task는 `docs/tasks/001`(범용/채팅
> 분리): `packages/css`의 `qf-*` 클래스를 범용 레이어와 chat 레이어로 모듈화하고, 변경분을
> 빌드→qufox 벤더 sync 하되 qufox 시각 회귀 0을 유지하세요. raw 값 금지·토큰 우선·a11y AA를
> 준수하고, 완료 시 REPORT(빌드 결과 + 계약 테스트 + sync byte-diff + reviewer 판정)를
> 남기세요.

---

## Roadmap

```
074 (이 문서)   design-qufox 셋업 + 부트스트랩 + 벤더 소비 + 핸드오프
074-follow      (design-qufox 내부) 범용/채팅 분리·모듈화
0xx             토큰 JSON(DTCG) 고도화 + components.json 매니페스트 심화
0xx             design.qufox.com 라이브(073 nginx 절차, 소스=design-qufox)
(2nd 소비자 시) 벤더링 → 버전드 패키지/Changesets로 하드닝, (선택) MCP 서버
```
