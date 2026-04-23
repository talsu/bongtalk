# Task 036 — 운영 안정성: Loki 로그 중앙화 + PITR/WAL 아카이빙 → main deploy

## Context

feature-backlog F-1/F-2/F-3 완결 후 베타 트래픽 쌓이기 전
마지막 인프라:

1. 로그가 각 container (qufox-api / web / webhook / backup /
   minio 등) 에 산재 → 운영 이슈 조사가 container 별 `docker
logs` 여러 번 호출
2. Postgres 백업은 일일 `pg_dump` 뿐 → RPO 24시간. WAL
   아카이빙 없음

036 은 기존 monitoring stack (`/volume2/dockers/grafana/`) 에
**Loki + Promtail** 추가 + qufox Postgres에 **WAL 아카이빙 +
주간 base backup + PITR 복구 테스트** 활성화.

기존 monitoring stack:

- Path: `/volume2/dockers/grafana/docker-compose.yml`
- Services: `prometheus` + `grafana` + `mongodb-exporter` (+
  추후 추가될 `loki` + `promtail`)
- Network: `internal` + `monitoring`
- Config 경로: `prometheus/prometheus.yml` + `grafana/provisioning/` + `grafana/dashboards/`

Grafana admin 자격증명은 사용자 제공 (handoff 전용; doc / git /
PR body 에 **절대 기록 금지**).

## Scope (IN) — 7 chunks

### A. Loki + Promtail 컨테이너 추가

- `/volume2/dockers/grafana/docker-compose.yml` 에 두 서비스
  추가:

  ```yaml
  loki:
    image: grafana/loki:2.9
    container_name: loki
    restart: unless-stopped
    ports: ['3100:3100']
    volumes:
      - ./loki/config.yaml:/etc/loki/config.yaml:ro
      - /volume3/qufox-data/loki:/loki
    command: -config.file=/etc/loki/config.yaml
    networks: [internal, monitoring]

  promtail:
    image: grafana/promtail:2.9
    container_name: promtail
    restart: unless-stopped
    volumes:
      - ./promtail/config.yaml:/etc/promtail/config.yaml:ro
      - /var/lib/docker/containers:/var/lib/docker/containers:ro
      - /var/run/docker.sock:/var/run/docker.sock:ro
    command: -config.file=/etc/promtail/config.yaml
    networks: [internal, monitoring]
    depends_on: [loki]
  ```

- Loki config (`/volume2/dockers/grafana/loki/config.yaml`):
  - BoltDB shipper + filesystem (단일 노드, beta 규모)
  - Retention **14일**
  - Chunk 경로: `/loki/chunks`, index: `/loki/indexes`
- Promtail config (`/volume2/dockers/grafana/promtail/config.yaml`):
  - Docker service discovery (모든 container)
  - 라벨: `container_name`, `service` (qufox- prefix split), `image`
  - qufox-\* container 의 Pino JSON 로그 파싱 → `level`, `traceId`,
    `module`, `errorCode` 추출
  - nginx-proxy-1 / mongodb-exporter 등 plain text 는 stream
    으로만 수집
- Data 위치 (project_data_layout 메모리 준수):
  - `/volume3/qufox-data/loki/` (chunks + indexes)

### B. Sensitive 필드 redaction

Promtail pipeline_stages 로 민감 데이터 삭제:

```yaml
pipeline_stages:
  - json: { expressions: { level, msg, traceId } }
  - replace:
      expression: '(?i)("password"\s*:\s*)"[^"]*"'
      replace: '$1"<redacted>"'
  - replace:
      expression: '(?i)("(jwtToken|refreshToken|webhook_secret|GITHUB_WEBHOOK_SECRET)"\s*:\s*)"[^"]*"'
      replace: '$1"<redacted>"'
  - labels: { level, service }
```

테스트 로그 `POST /auth/login` 로 redaction 작동 확인.

### C. Grafana 데이터소스 + 대시보드 (provisioning)

- `/volume2/dockers/grafana/grafana/provisioning/datasources/loki.yml` 신규:
  ```yaml
  apiVersion: 1
  datasources:
    - name: Loki
      type: loki
      access: proxy
      url: http://loki:3100
      isDefault: false
  ```
- Grafana restart 시 자동 provisioning (수동 UI 작업 불필요)
- 신규 대시보드 `qufox-logs.json` — `/volume2/dockers/grafana/grafana/dashboards/` 에 commit:
  - Panel 1: service 별 error rate (`sum by (service) (rate({level="error"}[5m]))`)
  - Panel 2: recent errors 테이블 (`{level="error"} |= ""` live tail)
  - Panel 3: webhook delivery log stream (`{container_name="qufox-webhook"}`)
  - Panel 4: auto-deploy 결과 log (`{container_name="qufox-webhook"} |~ "deploy.result"`)
- 기존 `qufox-service.json` (007) 에 "Recent Errors" Loki
  panel 추가 (overlay 형식)

### D. Postgres WAL 아카이빙

`/volume2/dockers/qufox/docker-compose.prod.yml` 의 `qufox-postgres-prod`:

- Volume mount 추가: `/volume3/qufox-data/backups/pg-wal:/archive`
- Env 또는 command 로:
  ```
  -c archive_mode=on
  -c archive_command='test ! -f /archive/%f && cp %p /archive/%f'
  -c wal_level=replica
  -c max_wal_senders=3
  ```
- `SHOW archive_mode` / `SHOW archive_command` 검증
- 첫 배포 후 10분 내 `/volume3/qufox-data/backups/pg-wal/` 에
  file 생성 확인

### E. Base backup + PITR 복구 테스트

- `scripts/backup/pg-base-backup.sh` 신규:
  - `pg_basebackup -h <db> -D /volume3/qufox-data/backups/pg-base/<date>/ -Ft -z`
  - 주 1회 cron (일요일 02:00), 4주 retention (최근 4 backup)
  - `qufox-backup` container (009/011) cron 에 추가
- `scripts/backup/pitr-restore-test.sh` 신규:
  - 최근 base backup + 그 이후 archived WAL → 임시
    `pg-pitr-test` container 에 복원
  - `SELECT count(*) FROM "User"` ≥ 1 검증
  - `postgresql.conf` 에 `recovery_target_time` 으로 2시간 전
    상태 복구 테스트
  - 성공 시 임시 container destroy + log entry
    `/volume3/qufox-data/backups/pitr-restore-test.log`
  - 실패 시 Slack webhook (011) 알림
  - 주 1회 cron (일요일 03:00, base backup 1시간 후)

### F. Prometheus alert 규칙 + 런북

- `/volume2/dockers/grafana/prometheus/alerts/qufox-logs.yml`
  (없으면 신규) + `prometheus.yml` 에 rule_files 추가:
  ```yaml
  groups:
    - name: qufox-logs
      rules:
        - alert: LokiHighErrorRate
          expr: sum(rate({level="error"}[5m])) > 10
          for: 5m
          labels: { severity: warning }
          annotations: { runbook: 'docs/ops/runbook-logs.md' }
        - alert: WalArchiveLag
          expr: time() - max(node_filesystem_files{mountpoint="/archive"}) > 3600
          for: 10m
          labels: { severity: critical }
          annotations: { runbook: 'docs/ops/runbook-pitr-restore.md' }
        - alert: PitrRestoreFailed
          expr: (time() - qufox_pitr_restore_last_success_timestamp) > 9*86400
          for: 1h
          labels: { severity: critical }
  ```
- Runbook 2종:
  - `docs/ops/runbook-logs.md` — Loki 쿼리 예제 (container별 로그, error filter, traceId 추적, time range)
  - `docs/ops/runbook-pitr-restore.md` — 실 복구 절차 (base
    backup + WAL 로 특정 시점 복구), 권장 테스트 command

### G. develop → main auto-promote + Pane 1 auto-forward 14th

표준 flow. 단 **배포 검증 시 기존 monitoring compose 재시작
필요**:

- `cd /volume2/dockers/grafana && docker compose up -d` (loki +
  promtail 신규 생성 + grafana provisioning reload)
- `cd /volume2/dockers/qufox && docker compose -f docker-compose.prod.yml up -d qufox-postgres-prod` (WAL 아카이빙 환경변수 반영)

FINAL REPORT 추가 검증:

- `curl http://127.0.0.1:3100/loki/api/v1/labels` → 200 + labels list
- Grafana UI (사용자 admin 자격증명 로그인) 에서 Loki datasource 테스트 pass
- `ls /volume3/qufox-data/backups/pg-wal/` 첫 WAL file 존재
- `bash scripts/backup/pitr-restore-test.sh` 첫 실행 → `success`

## Scope (OUT)

- Loki 분산 모드 / HA
- Grafana Tempo (OTel 트레이싱 backend) — 007 OTel은 수집만, 시각화는 별도 task
- Prometheus long-term storage (Thanos / Cortex)
- Postgres streaming replication / hot standby
- nginx-proxy-1 외부 container 로그 상세 수집 (stream만 OK)
- PagerDuty / 외부 알림 에스컬레이션
- Grafana alert UI (Prometheus rule 만)
- Custom emoji / Voice / Group DMs / mecab-ko / 027 cleanup
- DS 변경 (이번 task는 UI 무관)

## Acceptance Criteria (mechanical)

- `pnpm verify` green (API / web 코드 변경은 없거나 최소 — 이번
  task는 infra 중심이지만 CI는 기존 그대로)
- `docker compose -f /volume2/dockers/grafana/docker-compose.yml up -d`
  성공, `loki` + `promtail` 두 container `Up`
- `curl -s http://127.0.0.1:3100/loki/api/v1/labels | jq '.data | length'` ≥ 3 (container_name / service / level 최소)
- Loki 쿼리 `{container_name="qufox-api"} |= "error"` 결과 0 이상 반환
- Grafana 로그인 (사용자 제공 자격증명) → Sources 에 Loki 표시 + "Save & Test" pass
- Grafana `qufox-logs` 대시보드 import 됨 + 4 panel 모두
  데이터 표시
- Promtail redaction 검증: 테스트 `POST /auth/login` 호출 후
  Loki 쿼리에서 `password=<redacted>` 만 보임 (raw password X)
- Postgres `SHOW archive_mode` → `on`
- `/volume3/qufox-data/backups/pg-wal/` 에 첫 WAL file ≥ 1 존재
  (배포 후 10분 내)
- `bash scripts/backup/pg-base-backup.sh` 실행 → `/volume3/qufox-data/backups/pg-base/<date>/` directory + `base.tar.gz` 생성
- `bash scripts/backup/pitr-restore-test.sh` 실행 → 임시 container
  restore + User count ≥ 1 + cleanup + log entry
- Prometheus alert 3개 rule 로드 확인 (`/api/v1/rules` API)
- 런북 2종: `docs/ops/runbook-logs.md` + `docs/ops/runbook-pitr-restore.md`
- DS `mobile.css` / `tokens.css` / `components.css` / `icons.css`
  untouched
- 3 artefacts: `036-*.md`, `036-*.PR.md`, `036-*.review.md`
- 1 eval: `evals/tasks/047-loki-pitr.yaml`
- Reviewer subagent 실제 스폰
- 직접 develop merge → main auto-promote via webhook
- `.deploy/audit.jsonl` (path `/volume2/dockers/qufox-deploy/.deploy/`)
  last entry `exitCode=0` + sha matches main tip
- `GET https://qufox.com/api/readyz` 200 + idle-window 30s
- **Pane 1 auto-forward 14번째**
- FINAL REPORT 자동 출력 포함:
  - develop/main SHA + exitCode + /readyz + idle + wall
  - 청크 A~G 산출물 표
  - Loki labels 리스트
  - 첫 archived WAL file 이름 + 크기
  - PITR 복구 테스트 첫 실행 결과 (복원 row count)
  - Grafana 신규 대시보드 JSON export or screenshot 참조
  - Deferred TODO(task-036-follow-\*)
- Feature branch retained

## Prerequisite outcomes

- 035 merged + deployed (`d38febe` main)
- `/volume2/dockers/grafana/docker-compose.yml` 현재 동작
  (prometheus + grafana + mongodb-exporter)
- `/volume2/dockers/grafana/prometheus/prometheus.yml` + rule
  파일들 존재
- `/volume2/dockers/grafana/grafana/provisioning/` 구조 (datasources /
  dashboards 하위)
- `/volume2/dockers/grafana/grafana/dashboards/` 존재 (007 의
  `qufox-service.json` 등)
- `/volume3/qufox-data/` 아래 `loki/` + `backups/pg-wal/` +
  `backups/pg-base/` 생성 가능 (disk space 확인)
- qufox-postgres-prod container 재시작 허용 (WAL 설정 적용)
- 기존 `qufox-backup` cron container (011) 에 task 추가 가능
- 011 `SLACK_WEBHOOK_URL` env (optional, PITR 실패 알림용)
- Grafana admin 자격증명 (사용자 제공, handoff 전용)

## Design Decisions

### Loki 는 monitoring stack 에 통합

`/volume2/dockers/grafana/docker-compose.yml` 하나에 prometheus/
grafana/loki/promtail 이 함께 동작. Grafana 가 Loki datasource
쉽게 참조 가능. qufox compose 분리 대신 monitoring 중심 compose.

### Data 는 `/volume3/qufox-data/loki/`

project_data_layout 메모리 규약. `/volume2` 는 container 구성만,
persistent 데이터는 `/volume3`. Loki 의 chunks + indexes 전부
포함.

### 14일 retention

베타 규모: 100 users × 1MB/day = ~1.5GB / 14d 로 여유. 추후
트래픽 증가 시 Grafana Cloud Loki 로 전환 또는 retention 축소.

### BoltDB + filesystem (단일 노드)

Loki 분산 모드는 S3 backend 필요 + 운영 복잡도. 베타 규모는
단일 노드로 충분. MinIO 연동은 OUT.

### Grafana provisioning

Datasource + dashboard 모두 YAML/JSON 으로 git commit. Grafana
restart 시 자동 로드 → reproducible. 수동 UI 수정은 임시.

### Admin 자격증명 handoff 전용

doc / git / PR body 에 **절대 기록 금지**. pane 0 handoff prompt
에만 포함 (pane 0 session history 에만 남음). Grafana container
의 `GF_SECURITY_ADMIN_PASSWORD` 는 이미 기존 compose 에 설정된
것으로 가정 (없으면 `.env` 파일에서 읽는 것을 확인).

### WAL 아카이빙 + 주간 base backup + 주간 PITR test

RPO: 기존 24h → 분 단위 (WAL 은 매 16MB or timeout 마다 archive).
RTO: 복원 시간 (base + WAL replay, 베타 규모 ~5분). 주 1회 복구
테스트로 "untested backup = Schrödinger's backup" 방지 (009
pattern).

### PITR test 가 metric 으로 보고

`qufox_pitr_restore_last_success_timestamp` gauge. 마지막 성공
시점이 9일 넘으면 alert → 실패 detection 자동화.

## Non-goals

- HA / 분산 Loki
- Grafana Tempo / OTel backend 시각화
- Streaming replication
- Thanos / Cortex long-term Prometheus
- 외부 PagerDuty / OpsGenie
- Custom emoji / Voice / Group DM / mecab-ko
- DS 변경

## Risks

- **Postgres restart 필요**: WAL 아카이빙 설정 반영 시 container
  restart. 짧은 downtime (1-2분). auto-deploy 의 rollout 패턴
  을 활용하거나 별도 maintenance window. mitigation: 배포 시간대
  조정 + readyz 모니터링
- **Loki container 가 monitoring stack 에 추가되면 기존
  Grafana + Prometheus 도 재시작 필요**: `docker compose up -d`
  는 dependency 없는 container 만 재생성하지만 provisioning
  refresh 위해 grafana restart. 수분 downtime 허용
- **기존 Grafana dashboard 의 손실 우려**: `grafana/data/` 의
  sqlite 는 volume 이므로 container restart 에 영향 없음. 확인
  필요
- **PITR restore test 가 실 Postgres container 를 interrupt**:
  test container 는 별도 port / data dir 사용하므로 prod 무관.
  다만 `/volume3` 디스크 space 공유 — pg-base-backup + pg-pitr-test
  가 가득 찰 경우 prod WAL archive 가 실패할 수 있음. disk monitoring
- **Promtail redaction 이 모든 민감 필드 못 잡음**: 정규식 기반
  이라 edge case 있음. 기본 4 필드 (password / jwtToken /
  refreshToken / webhook_secret) 만 우선. 추가 발견 시 follow
- **qufox-api 의 Pino JSON 형식이 Promtail pipeline 과 정확히
  맞는지**: 007 의 Pino 설정 재확인. `level` field name 이
  `level` 인지 `lvl` 인지 등. UNDERSTAND 에서 검증
- **Prometheus rule_files 가 Loki alert (LogQL) 지원 안 함**:
  Prometheus alert 은 Prometheus metric 기반. Loki 기반 alert 은
  Loki Ruler (Grafana Enterprise) 또는 Grafana alerting. 베타
  수준은 Prometheus 로 `loki_request_*` 메트릭 기반 alert 으로
  대체. Mitigation: 정확히 Loki alert 이 필요하면 Grafana
  alerting (UI) 이나 log shipper + custom metric. 이번 task 의
  `LokiHighErrorRate` 는 metric 기반 재구성
- **WAL archive directory disk fill**: 14일 retention 을 자동
  삭제하려면 `pg_archivecleanup` 또는 별도 cleanup cron. 이번
  task 에 포함 (pg-base-backup.sh 내 archivecleanup)
- **Monitoring stack 이 qufox 와 별도 repo/디렉토리** → docs/task
  에 commit 되는 파일은 qufox repo 에. monitoring compose 변경은
  외부 경로 파일 수정 → git 추적 밖. mitigation: 변경 diff 를
  task PR.md 에 captured + `/volume2/dockers/grafana/` 내부도
  git 인지 확인 (대개는 아님)

## Progress Log

_Implementer 채움_

- [ ] UNDERSTAND (기존 monitoring stack 정확한 구조, qufox-api
      Pino log format, grafana provisioning 경로, 007 alerts
      기존 rule 위치, `/volume3/qufox-data/` disk free, qufox-backup
      cron 확장 가능 영역, Grafana compose 에 admin 패스워드
      저장 방식)
- [ ] PLAN approved
- [ ] SCAFFOLD (loki + promtail config 초안, pg-base-backup /
      pitr-restore-test 스크립트 stub, provisioning YAML /
      dashboard JSON 초안)
- [ ] IMPLEMENT (A → B → D → E → C → F)
- [ ] VERIFY (`pnpm verify` + 실 container 재시작 + Loki 200 +
      Grafana 로그인 + datasource test + archived WAL file 확인 + pitr-restore-test 성공)
- [ ] OBSERVE (labels 리스트, 첫 WAL file size, Grafana 대시보드
      screenshot, alert rule load 확인)
- [ ] REFACTOR
- [ ] REPORT (develop merge → main auto-promote via webhook →
      FINAL REPORT auto-printed + **pane 1 auto-forwarded 14th**)
