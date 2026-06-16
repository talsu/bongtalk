# 073 · design.qufox.com 디자인 시스템 쇼케이스 공개 (Phase 1)

> 상태: SUPERSEDED-BY [[074-design-system-repo-separation]] (호스팅 위치 변경)
> 작성: 2026-06-16
> 선행 결정: 공개 범위 = **완전 공개** / 진행 순서 = **쇼케이스 먼저, 범용화 정리는 점진적**
>
> ⚠️ 갱신(2026-06-16): 사용자가 DS를 별도 repo(`../design-qufox`)로 분리하기로 결정 → 쇼케이스
> 카탈로그/`design.qufox.com` 호스팅 소스가 **design-qufox repo로 이전**됨(074). 본 문서의
> **이중청중(인간+AI) 원칙 · `llms.txt`/AI 진입 가이드 · nginx 절차(Option A static root, tetris
> 선례) · 완전 공개 결정**은 074로 그대로 계승된다. "qufox 모노레포 안에서 노출" 부분만 폐기.

---

## Context

qufox 를 구축하며 `apps/web/public/design-system/` 에 디자인 시스템(DS)이 함께 만들어졌고,
이는 모든 UI 작업의 source of truth 입니다(메모리 `feedback_design_system_source_of_truth.md`).
사용자는 이 look & feel 을 향후 qufox 패밀리 사이트에서 재사용하고자 하며, 그 전제로
**범용화된 결과물을 별도 도메인에서 눈으로 확인**하고 싶어 합니다. 이를 위해
`design.qufox.com` 도메인을 이미 등록해 두었습니다.

업계 용어로 이 산출물은 **리빙 스타일 가이드(living style guide)** 또는
**디자인 시스템 문서 사이트(design system documentation site)** 라고 부릅니다
(Material / Carbon / Polaris / Primer 가 같은 부류의 공개 사이트).

핵심 사실 — qufox 는 이미 그 "씨앗"을 보유:

- `apps/web/public/design-system/index.html` (약 3,200줄): 토큰 스와치 + 컴포넌트 갤러리
  - 데스크톱/모바일 목업을 담은 완성도 높은 카탈로그.
- 이 카탈로그는 실앱과 **동일한** `tokens.css` / `components.css` / `mobile.css` / `icons.css`
  를 link 하므로, 토큰을 바꾸면 카탈로그와 실앱이 동시에 갱신되는 **진짜 "living"** 문서.
- CSS 링크가 **상대경로**(`href="tokens.css?v=7"`)라 `design-system/` 폴더를 통째로
  서빙하면 그대로 동작. 파비콘만 `../brand-assets/` 동봉 필요, 폰트는 Google Fonts 외부 의존.

인프라 현황(조사 결과, `/volume2/dockers/nginx`):

- 수동 단일 `nginx.conf` 방식(자동 라벨/companion 없음). 새 서브도메인 = `nginx.conf` 에
  server 블록 직접 추가.
- 인증서: 단일 멀티-SAN 인증서 1장(cert-name `talsu.net`)을 모든 server 가 공유.
  `new.sh` 의 `-d` 목록에 도메인 추가 후 재발급(webroot ACME). 만료 2026-09-13.
- 정적 사이트 선례 존재: `tetris.qufox.com`(호스트 폴더 static root), `skulk.qufox.com`(최근 추가 템플릿).
- 채팅앱 스택(`docker-compose.prod.yml`) 및 webhook 자동배포와 **완전 독립**. nginx 작업은
  Synology 특성상 root 권한 필요, nginx 디렉터리는 **별도 git repo**(qufox repo 아님).

---

## Design Principle — 이중 청중 (인간 + AI)

이 DS의 핵심 컨셉은 **사람과 AI가 모두 활용하는 디자인 시스템**이다. `design.qufox.com`
의 설명은 사람이 읽기 위한 것이자, 동시에 **AI 에이전트가 도메인을 fetch 하여 내용을
효과적으로 파악하고, 자신이 작업할 APP에 DS를 그대로 반영**할 수 있도록 작성한다.
즉 모든 설명·문서는 **"인간과 AI가 함께 보는 것"을 전제**로 한다. 이는 부가 기능이 아니라
DS의 정의 자체에 포함되는 1급 요구사항이다.

업계 흐름과도 일치한다 — 디자인 토큰은 본래 기계 가독(machine-readable) 계약이며, 최근에는
문서 사이트 자체를 LLM이 읽기 쉽게 만드는 관행(`llms.txt` 같은 진입 요약, 시맨틱 HTML,
안정적 URL, 복사 가능한 클래스 스니펫)이 자리잡고 있다. 본 프로젝트는 이를 처음부터 전제한다.

설계 요구(단계별 충족):

- **사람용**: 시각적 카탈로그(스와치·목업·컴포넌트 갤러리) — 이미 보유.
- **AI용**: (a) fetch 가능한 안정적 URL·시맨틱 HTML, (b) 토큰 값과 데스크톱 `qf-*` / 모바일
  `qf-m-*` 클래스명을 **텍스트로 직접 획득** 가능(이미지 only 금지), (c) "이 APP에 어떻게
  반영하는가"를 담은 **AI 진입 가이드**(`llms.txt` 또는 `/ai-guide`), (d) DS 규약(raw
  hex/px/shadow 금지, 토큰·클래스 우선)의 명문화.
- **장기**: 토큰 JSON(DTCG) + 컴포넌트 매니페스트(JSON) + (선택) MCP 서버로 에이전트가
  DS를 직접 질의 — Phase 3~ (073 범위 밖, 아래 Roadmap 참조).

---

## Goal

기존 DS 카탈로그를 **공개적으로** `design.qufox.com` 에 노출하되, **사람과 AI가 함께 보는
것을 전제**로(위 Design Principle) 한다 — 사람은 시각 카탈로그로, AI는 도메인을 fetch 하여
토큰·클래스·규약을 파악하고 작업 대상 APP에 반영할 수 있게 한다. 추가 빌드 도구·런타임·
SaaS 없이, 기존 정적 자산을 재사용하여 NAS-only 정책을 유지한다. 범용/채팅 분리 및 토큰
파이프라인 등 "정리"·"깊은 기계 가독화" 작업은 후속 태스크로 점진 진행한다.

---

## Scope

### IN

1. **콘텐츠 게시 경로 확립 (SSOT 보존)**

   - source 는 repo 의 `apps/web/public/design-system/` 그대로 유지(이중 진실원 금지).
   - 게시용 publish 스크립트 작성(`scripts/showcase/publish-design-site.sh` 가칭):
     `design-system/` + 필요한 `brand-assets/`(파비콘) 를 호스트 served 디렉터리로 복사/동기화.
   - served 디렉터리는 NAS 데이터 레이아웃 관례에 따라 `/volume3/qufox-data/design-showcase/`
     권장(`/volume2` 는 코드 디스크). tetris 선례는 `/volume2` 사용 — 둘 다 가능, 데이터
     레이아웃 일관성상 `/volume3` 채택.

2. **공개용 다듬기**

   - `<title>`, `<meta description>`, OG 태그, 파비콘 경로 정합성 점검.
   - 루트(`https://design.qufox.com/`) 접근 시 카탈로그가 바로 보이도록 진입 경로 정리
     (nginx `index` 또는 `try_files` 로 `design-system/index.html` 진입).
   - **완전 공개 전제 안전 점검**: 내부 전용/미완성 표식, 내부 경로/호스트명, 시크릿,
     PII 노출이 없는지 1회 전수 점검(현 카탈로그는 CSS/목업 위주라 위험 낮으나 공개이므로 필수).

3. **AI 진입 가이드 (경량, Phase 1 분량) — Design Principle 충족**

   - `design.qufox.com/llms.txt`(또는 `/ai-guide.md`) 추가. AI가 fetch 1회로 DS를 파악·반영할 수
     있도록 markdown 으로: ① DS 한 줄 정의, ② 토큰 카테고리와 CSS 변수 위치(`tokens.css`),
     ③ 데스크톱 `qf-*` / 모바일 `qf-m-*` 클래스 사용 규약, ④ 핵심 규칙(raw hex/px/shadow 금지,
     토큰·클래스 우선), ⑤ 주요 섹션 링크 맵.
   - 카탈로그 fetch-friendliness 점검: 시맨틱 헤딩 구조, 안정적 섹션 앵커, 토큰·클래스가
     텍스트로 노출(스크린샷 only 금지).
   - 깊은 기계 가독화(토큰 JSON/DTCG, 컴포넌트 매니페스트, MCP)는 **OUT → Phase 3~**.

4. **nginx + 인증서 변경분 산출 (적용은 root 작업)**

   - `design.qufox.com` 443 server 블록 초안(인증서는 기존 `live/talsu.net/*` 재사용,
     static root + `try_files` SPA-less fallback).
   - 80포트 redirect server 의 `server_name` 에 `design.qufox.com` 추가(ACME + HTTPS redirect).
   - `new.sh` / `docker-compose.certbot.yml` 의 `-d` 목록에 `-d design.qufox.com` 추가 diff.
   - 서빙 옵션 = **Option A(호스트 static root 바인드)** 채택. 근거는 Risks/Decisions 참조.

5. **검증 절차 문서화**
   - DNS → 인증서 재발급 → nginx.conf 편집 → `nginx -t` → reload(또는 마운트 추가 시
     `docker compose up -d`) → curl 검증 순서.

### OUT (후속 태스크)

- DS 의 **범용 / 채팅 특화 분리** 정리(`components.css` / `mobile.css` 모듈화) → Phase 2.
- 토큰을 JSON 원본 + Style Dictionary 자동 빌드로 전환 → Phase 3.
- `packages/ui` 패키지 승격 및 다른 패밀리 사이트 소비 → Phase 4.
- Storybook / Astro 등 정적 사이트 생성기 도입(현 단계 오버스펙, 향후 트리거 시 재검토).
- `qf-*` CSS 클래스를 React 컴포넌트로 추출.
- 인터랙티브 기능(토큰 클릭 복사, prop 토글, 코드 스니펫 복사, 검색) — 점진 개선 백로그.
- 폰트 self-host 화(현재 Google Fonts 외부 의존, NAS-only 강화는 별도 백로그).

---

## Acceptance Criteria (기계 검증)

> `<HOST>` = NAS 공인 엔드포인트. nginx 호스트 포트는 10080/10443(프록시 앞단 매핑 고려).

1. `curl -sSI https://design.qufox.com/ | grep -E "HTTP/.+ 200"` → 200 응답.
2. TLS: `echo | openssl s_client -servername design.qufox.com -connect design.qufox.com:443 2>/dev/null | openssl x509 -noout -checkend 0 -text | grep -q "design.qufox.com"` → 유효 + SAN 포함.
3. 카탈로그 CSS 무결성(404 없음): `for f in tokens components mobile; do curl -sSI "https://design.qufox.com/design-system/$f.css" | grep -qE "HTTP/.+ 200" || exit 1; done`.
4. **SSOT 보존**: served `tokens.css` 가 repo 원본과 동일 — `cmp -s /volume3/qufox-data/design-showcase/design-system/tokens.css apps/web/public/design-system/tokens.css`.
5. nginx 구문: `sudo docker exec nginx-proxy-1 nginx -t` exit 0.
6. **공개 안전**: `gitleaks detect` clean(신규 스크립트/문서 대상). served HTML 에 내부 경로/시크릿 마커 부재 — 점검 grep 결과 첨부.
7. **회귀 없음**: `curl -sSI https://qufox.com/ | grep -E "HTTP/.+ 200"` 및 앱 `/readyz` 200 유지(채팅앱 무영향).
8. publish 스크립트 멱등성: 두 번 실행해도 동일 결과(`diff` 무변화).
9. `pnpm verify` green(repo 측 신규 스크립트가 lint/typecheck 게이트를 깨지 않음).
10. **AI 진입 가이드**: `curl -sS https://design.qufox.com/llms.txt` 200, 내용에 토큰 카테고리 · `qf-*`/`qf-m-*` 클래스 규약 · 핵심 규칙(raw hex 금지)이 포함(grep 검증). 카탈로그 핵심 토큰/클래스가 HTML 텍스트로 노출(이미지 only 아님) — `curl -sS https://design.qufox.com/design-system/ | grep -q "qf-btn"`.

---

## Non-goals

- 채팅 PRD 페이지(`/prd/`)는 본 작업 범위 밖(별개 산출물).
- `design.qufox.com` 을 통한 API/동적 기능 제공(순수 정적 쇼케이스).
- DS 내용 자체의 디자인 변경(노출만, 리디자인 아님).
- webhook 자동배포 파이프라인에 design 사이트 게시를 편입(수동 인프라 작업으로 분리 유지).

---

## Risks & Decisions

- **R1 — "living" 보존 vs 스냅샷**: 게시가 단순 복사면 시간이 지나며 repo 와 drift.
  → publish 스크립트를 명시적 단계로 두고, source 는 항상 repo `apps/web/public/design-system/`
  로 고정(이중 진실원 금지). 향후 배포 훅에 publish 1줄 편입은 백로그(현재는 수동).
- **R2 — 서빙 방식 선택**: Option A(호스트 static root, tetris 선례·추가 컨테이너 0) 채택.
  Option C(별도 nginx 컨테이너)는 독립 빌드/배포가 필요해질 때 승격. Option D(qufox-web 라우트
  편입)는 SPA 라우팅 충돌·결합도 증가로 기각.
- **R3 — nginx 마운트 변경**: served 디렉터리를 새 `:ro` 바인드로 추가하면 reload 가 아니라
  `docker compose up -d`(짧은 재생성) 필요. nginx.conf 만 변경 시엔 무중단 reload.
  → 변경 전 `nginx.conf.bak.<ts>` 백업 관행 유지, nginx repo 에 커밋.
- **R4 — 완전 공개**: 카탈로그가 공개되므로 미완성/내부 흔적 점검 필수(AC #6).
  현 내용은 CSS·목업 위주라 민감도 낮으나, 공개 후엔 캐시/인덱싱 가능성 고려.
- **R5 — root 권한**: nginx reload/recreate·certbot 은 docker.sock(root:root 660)로 root 필요
  (Synology). repo 측 산출물(publish 스크립트·문서)과 인프라 적용 단계를 분리해 기술.
- **R6 — 인증서 재발급 영향**: `new.sh --force-renewal` 은 전체 SAN(11개) 재발급. 만료
  2026-09-13 이전이므로 rate-limit 유의(주 5회 동일 도메인셋 한도). 1회 추가면 안전.
- **R7 — 자산 경로 정합성**: 파비콘 `../brand-assets/...` 상대경로 → `brand-assets/` 동봉
  필요. 폰트는 Google Fonts(외부) — 동작엔 문제없으나 NAS-only 강화는 OUT.

---

## Definition of Done

- [ ] AC #1–#9 전부 green, 검증 커맨드 출력 첨부.
- [ ] publish 스크립트 + nginx/cert 변경분(diff) 산출물 첨부.
- [ ] 공개 안전 점검 결과(grep/gitleaks) 첨부.
- [ ] `pnpm verify` 통과 로그 첨부.
- [ ] reviewer subagent 적대적 재독 통과(BLOCKER/HIGH fix-forward).

---

## Roadmap (이 태스크 이후)

```
073 (이 문서)  카탈로그 공개 + 경량 AI 진입 가이드        ← 즉시 가치, 인간+AI
074 (예정)     DS 범용 / 채팅 특화 분리·모듈화            ← 범용화 핵심
075 (예정)     토큰 JSON(DTCG) + Style Dictionary 빌드     ← 고도화 + 깊은 기계 가독화
              + 컴포넌트 매니페스트(AI 직접 소비용)
076 (예정)     packages/ui 승격 + 패밀리 사이트 소비        ← 재사용 실현
(선택, 후순위) DS MCP 서버 — 에이전트가 토큰/컴포넌트를 직접 질의           ← AI 소비 심화
```

`design.qufox.com` 은 074~076 진행 내내 사람에게는 "무엇이 범용이고 무엇이 정리됐는지"를
눈으로 확인하는 거울이자, **AI에게는 같은 URL을 fetch 하여 DS를 새 APP에 반영하는 단일
소스**가 된다(Design Principle — 이중 청중).
