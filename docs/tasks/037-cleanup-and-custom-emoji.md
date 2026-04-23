# Task 037 — Cleanup Sweep + Custom Emoji Upload → main deploy

## Context

036 까지 feature MVP + 운영 인프라 (배포 / 관측 / backup + PITR /
로그 중앙화) 모두 완성. 베타 사용자 받기 전 가볍게 청소 +
소소한 재미 기능 하나 추가:

1. **027 deprecated API 완전 삭제** — `/me/workspaces/:wsId/dms`
   계열, Global DM (033-034) 이후 UI 호출 site 0
2. **036 TODO-loki-ruler** 완결 — Loki LogQL 기반 `LokiHighErrorRate`
   alert 은 Prometheus rule 로 표현 어려워 deferred. Loki Ruler
   로 구현
3. **누적 LOW/NIT follow-up** 청소 — 032/034/035 follow 중 live
   marker 5-7건
4. **Custom emoji upload** — 워크스페이스 이모지 팩. 012
   attachments (MinIO) + 013 reactions (ReactionBar) + 031
   workspace settings 재사용

## Scope (IN) — 5 chunks

### A. 027 deprecated API 완전 삭제

- 대상 엔드포인트:
  - `GET /me/workspaces/:wsId/dms`
  - `POST /me/workspaces/:wsId/dms`
  - `GET /me/workspaces/:wsId/dms/by-user/:userId`
- 제거 대상:
  - Controller / service / module
  - shared-types 의 request / response schema
  - 027 int spec 중 deprecated path 만 제거 (data 모델 test 는
    유지 — 033 global DM 에서도 같은 table 쓰니까)
- 존재하는 workspace-scoped DM channel row (type=DIRECT +
  workspaceId NOT NULL) 는 **data 유지** — UI 진입 없으나 history
  보존. 완전 삭제는 장래 별도 task
- UI 호출 site 전수 grep (react-query keys + fetch URL):
  - `apps/web/src/` 에서 `/me/workspaces/.*dms` 패턴 0 hits
  - 없으면 deletion 안전
- commit prefix `chore(cleanup-027): remove deprecated workspace-scoped DM endpoints`

### B. 036 TODO-loki-ruler (`LokiHighErrorRate`)

- Loki Ruler 구성:
  - `/volume2/dockers/grafana/loki/rules/qufox.yml` 신규 (없으면
    디렉토리 생성):
    ```yaml
    groups:
      - name: qufox-logs
        interval: 1m
        rules:
          - alert: LokiHighErrorRate
            expr: sum(rate({level="error"}[5m])) > 10
            for: 5m
            labels: { severity: warning }
            annotations:
              summary: 'qufox error rate exceeded 10/min'
              runbook: 'docs/ops/runbook-logs.md'
    ```
  - Loki config `ruler:` 섹션 활성:
    ```yaml
    ruler:
      storage:
        type: local
        local: { directory: /loki/rules }
      rule_path: /tmp/loki-rules-tmp
      alertmanager_url: http://alertmanager:9093 # or 비활성
      ring: { kvstore: { store: inmemory } }
      enable_api: true
    ```
  - `/volume3/qufox-data/loki/rules/` 디렉토리 준비 (rule 파일
    bind-mount 또는 볼륨)
- Alertmanager 가 현재 monitoring stack 에 없을 수 있음 → 있으면
  연결, 없으면 alert 발견만 하고 전달 채널은 이번 task OUT
  (`alertmanager_url` 비활성 허용)
- Runbook `docs/ops/runbook-logs.md` 에 "error rate alert 대응"
  섹션 추가:
  - 최근 5분 error 로그 Loki 쿼리 예제
  - 서비스별 drill-down
  - 일반 원인 (외부 의존성 / migration race / deploy drift)
- 검증: `curl http://loki:3100/loki/api/v1/rules` 응답에 qufox
  rule group 포함

### C. 누적 LOW/NIT follow-up 청소

UNDERSTAND 단계에서 grep 으로 live marker 확인:

```
grep -rn 'TODO(task-03[2-6]-follow' apps/api apps/web services scripts docs 2>/dev/null
```

처리 우선순위 (예상, 실제는 grep 결과에 따름):

- 032-follow: `cap TOCTOU` — friend count 1000 cap race
- 032-follow: `P2002 block-flip` — 차단 토글 race 500 가능성
- 034-follow: nullable 전환 후 미반영된 edge case (있다면)
- 035-follow: 모바일 overlay 관련 edge case
- 036-follow: ops-level nit (WAL file 크기 한계 등, 있다면)

처리 규칙:

- 살아있는 marker 중 **최소 5건** 처리
- 각 fix commit prefix `fix(cleanup-<task-NNN>-<slug>)`
- 이미 fix-forward 된 marker → review.md status table 만 갱신
- 완전 해결 불가 / 설계 변경 필요 → 별도 task 로 이월 (FINAL REPORT 에 명시)

### D. Custom emoji upload (워크스페이스 이모지 팩)

**Schema:**

Prisma migration (reversible):

```
CustomEmoji {
  id           uuid pk
  workspaceId  uuid fk -> Workspace.id ON DELETE CASCADE
  name         varchar(32)     -- [a-z0-9_]{2,32}
  createdBy    uuid fk -> User.id
  storageKey   text            -- MinIO key
  mime         varchar(32)     -- 'image/png' | 'image/gif'
  sizeBytes    int
  createdAt    timestamptz default now()
  unique (workspaceId, name)
}
```

Indexes: `(workspaceId, createdAt DESC)`.

**API:**

- `POST /workspaces/:wsId/emojis/presign-upload` body
  `{ name, mime, sizeBytes }` → `{ emojiId, putUrl, storageKey,
expiresAt }` (012 패턴 — presign PUT). Validation: OWNER/ADMIN,
  name 정규식, mime 허용, sizeBytes ≤ 256 KB, per-workspace cap
  100
- `POST /workspaces/:wsId/emojis/:emojiId/finalize` — S3 HeadObject
  로 실제 upload 확인 후 row finalize (012 패턴)
- `GET /workspaces/:wsId/emojis` — list (cursor, 100개 cap 이라
  단일 페이지면 OK)
- `DELETE /workspaces/:wsId/emojis/:emojiId` — OWNER/ADMIN. DB
  row 삭제 + MinIO 객체 삭제 (orphan-gc 의 반대 — 원자 tx)
- Rate limit: upload presign 10/min/workspace, delete 30/min
- Storage layout: `qufox-attachments/<workspaceId>/emojis/<emojiId>-<safeFilename>`

**UI:**

- 013 **ReactionBar picker** 확장 — 워크스페이스 emoji 섹션 추가 (기본 Unicode emoji 위에)
- Composer 의 emoji picker 에도 동일 섹션
- 메시지 parser `:emojiname:` 패턴 감지 → `<img class="qf-emoji-custom" src="<presign GET url>" alt=":name:" title=":name:">` 렌더
  - 012 attachment presign GET 패턴 재사용 (TTL 60분)
  - React Query 로 workspace emoji list 캐시 (10분 staleTime)
- **Workspace settings** (031) 에 "이모지 관리" 탭 추가:
  - 업로드 버튼 (drag-drop 지원)
  - 이모지 grid (최대 100개)
  - 각 이모지에 이름, 작성자, 업로드 날짜 hover tooltip
  - 삭제 버튼 (OWNER/ADMIN, confirm dialog)
- 모바일: 동일 settings 에서 접근 가능 (기존 settings 패턴)

**스타일:**

- `qf-emoji-custom`: inline `<img>` 스타일 (width/height 20px inline
  text, 40px reaction picker). 013 의 `qf-reaction` 와 호환
- CSS 는 inline style + tokens (DS mobile.css / components.css
  untouched)

### E. develop → main auto-promote + Pane 1 auto-forward 15th

표준 flow. 특히:

- Prisma migration + MinIO bucket policy 확인
- Loki Ruler 활성 검증
- qufox-minio container 재시작 없어도 작동 (정상)

## Scope (OUT)

- Animated emoji (APNG / lottie)
- Cross-workspace emoji 공유 / marketplace
- Voice / Group DMs / mecab-ko / 큰 feature
- DS mobile.css / components.css 변경
- Alertmanager 배포 (없으면 alert 미전달 허용)
- 027 data 완전 삭제 (workspace-scoped DM channel rows)
- 기타 모든 누적 LOW/NIT 한 번에 처리 (최소 5건만, 나머지 이월)

## Acceptance Criteria (mechanical)

- `pnpm verify` green
- **A 검증**:
  - `grep -rn '/me/workspaces/.*dms' apps/api apps/web services` → 0 hits
  - 027 deprecated endpoint controller / service / schema 파일 삭제됨
  - 027 int spec 중 deprecated path test 제거됨
- **B 검증**:
  - `/volume2/dockers/grafana/loki/rules/qufox.yml` 존재
  - `curl http://loki:3100/loki/api/v1/rules` 응답에 `LokiHighErrorRate` alert 표시
  - `docs/ops/runbook-logs.md` 에 "error rate alert 대응" 섹션 존재
- **C 검증**:
  - `grep -rn 'TODO(task-03[2-6]-follow' apps services scripts | wc -l` 처리 전후 대비 **최소 5건 감소**
  - 각 cleanup commit prefix `fix(cleanup-...)` 5개 이상
- **D 검증**:
  - Prisma migration reversible (`add_custom_emoji_table.sql`)
  - `pnpm --filter @qufox/api test:int` green:
    - `custom-emoji-upload.int.spec.ts` (OWNER / ADMIN / MEMBER 거부
      / MIME 검증 / size 검증 / name 충돌 / cap 초과)
    - `custom-emoji-list.int.spec.ts`
    - `custom-emoji-delete.int.spec.ts` (MinIO object 도 삭제)
  - `pnpm --filter @qufox/web test:e2e` green:
    - `custom-emoji-upload.e2e.ts` (settings → upload → picker
      에 등장)
    - `custom-emoji-in-message.e2e.ts` (`:name:` 입력 → 렌더)
    - `custom-emoji-reaction.e2e.ts` (reaction picker 에서 선택
      → 메시지 reaction 에 custom emoji)
  - MinIO bucket 에 업로드된 이미지 존재 확인
- DS `mobile.css` / `tokens.css` / `components.css` / `icons.css`
  untouched (git diff 0)
- 3 artefacts: `037-*.md`, `037-*.PR.md`, `037-*.review.md`
- 1 eval: `evals/tasks/048-cleanup-custom-emoji.yaml`
- Reviewer subagent 실제 스폰 + transcript token count 기록
- 직접 develop merge → main auto-promote via webhook
- `.deploy/audit.jsonl` last entry `exitCode=0` + sha matches
  main tip
- `GET https://qufox.com/api/readyz` 200 + idle-window 30s
- **Pane 1 auto-forward 15번째**
- FINAL REPORT 자동 출력, 포함:
  - develop/main SHA + exitCode + /readyz + idle + wall
  - 청크 A~E 산출물 표
  - 027 deprecated endpoint 삭제 grep 증거
  - 036 Loki Ruler 활성 curl 결과
  - 처리된 follow-up marker 리스트 (task 번호 + slug + commit)
  - Custom emoji 업로드 + 메시지/reaction 렌더 capture
  - Workspace 이모지 cap 테스트 결과 (100 개 초과 거부)
  - Deferred TODO(task-037-follow-\*)
- Feature branch retained

## Prerequisite outcomes

- 036 merged + deployed (`c2f845e` main)
- 012 attachment storage (MinIO + presign upload / finalize 패턴)
- 013 ReactionBar + 8-emoji quick picker
- 031 Workspace Settings UI (SettingsOverlay 패턴)
- 014 Composer emoji picker
- 028 polish harness (회귀 guard 로 활용)
- Grafana Loki datasource + qufox-logs 대시보드
- 027 workspace-scoped DM endpoint 가 deprecated 된 상태에서
  호출 0

## Design Decisions

### 012 presign upload 재사용

이미 검증된 3단계 flow: client-side uuid + presign PUT + finalize
HEAD check. Custom emoji 도 동일. bucket / key prefix 만 다름
(`workspaceId/emojis/`).

### 013 ReactionBar 재사용

Picker 에 섹션 추가. emoji 자체는 Unicode + custom 혼재. custom
은 image 로 렌더. 기존 quick picker 6 + `+` 더보기 패턴 유지.

### Message parser `:name:` 패턴

Markdown / text content 에서 `:emojiname:` 패턴 감지. 014 의
parseContent (parseInline) 에 새 rule 추가. 009 의 ErrorCodeSchema
처럼 shared-types 에 패턴 regex commit.

### Workspace cap 100

베타 운영 기준. 실사용 feedback 으로 조정.

### DS 변경 최소

`qf-emoji-custom` 이 새 class 지만 mobile.css 아닌 app-scoped
CSS (features/emoji/ 내 작은 module) 또는 inline. DS source of
truth 메모리 준수.

### Loki Ruler 로 LokiHighErrorRate

Prometheus rule 로 Loki LogQL 을 표현 어려움 — 036 에서 `rate`
예제가 Prometheus syntax 이지 Loki 의 LogQL 이 아님. Loki Ruler
가 LogQL 지원. Grafana Enterprise 아니어도 OSS 로 ruler 가능.

### Alertmanager 없어도 alert rule 활성

alertmanager_url 비활성 → Loki 가 rule evaluate + /api/v1/rules
에 state 반환. 실제 알림 전달은 다음 task. 적어도 rule 은 running.

### 027 data 유지

Legacy DM channel row 는 소량 + history 성격. 삭제 risk > benefit
. 다음 purge task (task-034 purge worker 확장) 에서 고려.

## Non-goals

- Animated emoji / sticker pack
- Cross-workspace emoji 공유
- Emoji export / import
- 모든 follow-up 한 번에 청소 (최소 5건)
- Alertmanager 배포 (Loki Ruler 만)
- DS mobile.css 수정
- Voice / Group DMs / mecab-ko

## Risks

- **027 deprecated 삭제 시 클라이언트 잔존 호출**: grep 으로
  apps/web 전수 audit. 없으면 safe. 있으면 migration 선행.
- **Custom emoji MIME 검증 우회**: Content-Type header 만 믿으면
  위험. finalize 단계에서 S3 HeadObject 로 실제 mime 재검증 +
  파일 magic bytes 체크 (PNG header / GIF header 첫 4 bytes)
- **Emoji name 충돌 with Unicode shortcode**: `:smile:` 같은
  Unicode shortcode 와 custom emoji name 충돌 가능. 우선순위:
  custom emoji > Unicode shortcode (Discord 방식)
- **MinIO 객체 삭제 race**: DB 삭제 성공 + MinIO 삭제 실패 시
  orphan. 012 의 orphan-gc.sh 패턴 재사용 — nightly sweep 에
  custom emoji 용 orphan 감지 추가
- **Loki Ruler 설정이 기존 Loki 작동을 깰 수 있음**: 036 이후
  Loki 가 prod 에 running. ruler 섹션 추가로 재시작 필요. 배포
  시 monitoring stack 재시작 명시
- **Reaction picker UI 가 많은 emoji 로 성능 저하**: 100개
  workspace emoji + 기본 Unicode 수백 개. react-virtual 또는
  lazy load 로 해결. 이번 task 는 100 cap 이라 virtualization
  OUT
- **Cleanup 처리 중 회귀**: 각 fix 마다 기존 spec 이 여전히
  green 한지 확인. 028 polish harness 전부 통과 유지
- **Message parser `:name:` 패턴이 emoji 아닌 원시 텍스트 삼킴**:
  regex 가 narrow — `:[a-z0-9_]{2,32}:` 정확히 이 패턴만. 주변
  whitespace / punctuation 로 보호

## Progress Log

_Implementer 채움_

- [ ] UNDERSTAND (027 deprecated endpoint 전수 리스트, 032-036
      follow grep 결과, 012 presign 패턴, 013 ReactionBar 구조,
      014 parseInline 확장 지점, 031 workspace settings layout,
      036 Loki config 위치)
- [ ] PLAN approved
- [ ] SCAFFOLD (027 삭제 계획 + 대상 파일 리스트, CustomEmoji
      migration red, int spec stub, Loki ruler file stub)
- [ ] IMPLEMENT (A → B → C → D)
- [ ] VERIFY (`pnpm verify` + GHA int + e2e green + Loki ruler
      활성 + MinIO 객체 upload 검증)
- [ ] OBSERVE (027 grep 0, 036 ruler curl, cleanup commit 수,
      custom emoji 업로드 flow capture)
- [ ] REFACTOR
- [ ] REPORT (develop merge → main auto-promote via webhook →
      FINAL REPORT auto-printed + **pane 1 auto-forwarded 15th**)
