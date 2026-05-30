# Task 052 — PRD: 채팅 도메인 (Slack/Discord급)

## Context

DS 업그레이드(050) 완료 후, 사용자 요청: 이 DS를 바탕으로 실제 구현을
Slack/Discord급으로 할 수 있는 **엔지니어링-grade PRD**를 작성한다.

- 한국어. 채팅 위주(voice/영상통화 제외).
- DS처럼 **별도 HTML 페이지**(`apps/web/public/prd/index.html`)로 제작, 각 기능별
  **DS 기반 mock** 임베드.
- 기존 구현에 얽매이지 않고 **순수 재접근**. 필요 시 DS 업데이트 허용.
- "개발자/AI가 그대로 만들면 Slack/Discord급" 수준의 정밀도.
- 이후 DS+PRD 동시 감사 → 수정 반복 → 실제 구현 진입. **구현 의도가 PRD에 드러나야 함.**

## 산출물

- `apps/web/public/prd/index.html` — DS 쉘 톤, 사이드바(개요 00–04 + 도메인 D01–D17),
  DS CSS 링크로 mock 렌더, 아이콘 스프라이트 인라인.
- 개요: 비전·목표 / 범위·로드맵 / 정보구조·내비 / 도메인 모델 ER / 비기능 요구사항.
- 17 도메인 각각: 요약 · qufox_spec · 사용자 스토리 · FR(P0/P1/P2) · 데이터 모델 ·
  REST API · Socket.IO 이벤트 · 엣지 케이스 · 수용 기준 · DS 기반 mock.

## 도메인 (D01–D17)

D01 메시징 코어 · D02 채널/카테고리 · D03 DM/그룹DM · D04 스레드 ·
D05 반응/이모지 · D06 멘션/알림 · D07 검색 · D08 프레즌스/상태 ·
D09 읽음/미읽 · D10 핀/저장 · D11 첨부/미디어 · D12 역할/권한/모더레이션 ·
D13 워크스페이스/초대 · D14 프로필/설정 · D15 커맨드/단축키 ·
D16 리치 콘텐츠 · D17 실시간/동기화.

## 방법

1. 기능 리서치 워크플로(17 도메인 병렬, feature-benchmarker) — Slack/Discord 실제
   동작 → qufox 채팅 전용 명세. **결과: 17 도메인 / 299 FR.**
2. 섹션 authoring 워크플로(17 병렬 + IA/도메인모델 합성) — 각 도메인 JSON → HTML 섹션 + mock.
3. 결정론적 조립 → `<!--DOMAIN-SECTIONS-->` 마커 + ia/domain-model 교체.
4. Playwright 렌더 검증 → 커밋 → 배포(PRD 페이지는 신규 /prd/ 라우트, 실앱 dormant·additive).

## Scope

### IN

- PRD HTML 페이지 + mock. 필요 시 DS 신규 컴포넌트 추가(별도 커밋).

### OUT

- 실제 백엔드/프론트 구현 — 후속(PRD 감사 반복 후).
- voice/영상/화면공유, 결제 실거래, 서드파티 앱 생태계.

## DoD

- [x] 17 도메인 + 5 개요 섹션 완성(22 section), mock 렌더 정상
- [x] 구조 검증(section 22/22, div 2789/2789, 미정의 토큰 0, 미정의 아이콘 0)
- [x] Playwright 렌더 캡처(overview/ia/D01/D02/D08/D17)
- [x] 커밋 + 배포 — main `8035819`, deploy exitCode 0, **https://qufox.com/prd/ → 200**
- [x] DS+PRD 동시 감사 사이클 진입 준비

## Results

- `apps/web/public/prd/index.html` (≈872KB, 14.5k 라인). DS CSS(`?v=7`) 링크 + 아이콘
  스프라이트 103 + slash 추가. PRD-local 토큰 별칭(에이전트 mock 호환).
- 22 섹션: 개요 5(비전·범위/로드맵·IA·도메인모델·NFR) + 도메인 17(D01–D17).
- 리서치 17 도메인 / **299 FR**, 섹션 authoring 16+1(D08 별도) + IA/도메인모델 합성.
- 배포: main 8035819, develop a193235, feat/task-052 보존. /prd/ 200, /readyz 200.

## 다음 단계 (사용자 계획)

DS + PRD 동시 감사 → 수정사항 도출 → 몇 차례 업데이트 → 실제 서비스 구현.
구현 의도가 PRD에 드러나 있어야 함(현 PRD가 그 기준선).

## Note

PRD 페이지는 **additive**(신규 /prd/ 정적 라우트) — 실앱 컴포넌트 무영향
([[reference_ds_app_coupling]] 의 dormant 케이스). 배포 안전.
