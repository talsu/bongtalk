# Task 038 — 037 Follow-up Sweep → main deploy

## Context

037 에서 이월된 follow-up 3건 정리 + DS 보호 자동화. 새 feature 없이
빚만 털고 다음 큰 feature (Voice / Group DMs / mecab-ko) 전 기반을
다잡는다.

1. **emoji-gc** — 037-D 의 custom emoji 용 MinIO orphan 삭제를
   012 orphan-gc.sh 에 편입
2. **magic-bytes** — 037-D 의 finalize 단계에서 MIME 헤더 뿐 아니라
   실제 파일 magic 검증. 012 attachment finalize 에도 같은 규칙
3. **DS-confirm** — DS source of truth 4개 파일 diff 재확인 +
   CI guard 로 자동화. 메모리 `feedback_design_system_source_of_truth.md`
   의 룰을 PR 레벨에서 강제

## Scope (IN) — 3 chunks

### A. Custom emoji MinIO orphan-gc 확장

- 대상 script: `scripts/backup/orphan-gc.sh` (012)
- 기존: `qufox-attachments/<wsId>/messages/` 용 orphan 스캔
- 추가: `qufox-attachments/<wsId>/emojis/` prefix 스캔
  - DB `CustomEmoji.storageKey` IN-set 조회
  - MinIO object listing 결과 중 **DB 미등록 + lastModified 7일 이상**
    인 객체만 삭제
- dry-run 모드 (`--dry-run`) + apply 모드 (`--apply`) 분리 유지
- nightly cron 은 이미 편입 (012) — 스크립트 수정만 반영되면 자동 실행
- metric: `qufox_orphan_gc_emoji_deleted_total` (optional, 있다면
  012 pattern 재사용)
- 증거:
  - `scripts/backup/orphan-gc.sh --dry-run` 출력에 emoji prefix 섹션 확인
  - 1회 수동 실행 → 삭제 건수 + 남은 객체 수 로그

### B. 파일 magic bytes validation 강화

- 공통 helper: `apps/api/src/modules/storage/validate-magic-bytes.ts`
  - PNG: `89 50 4E 47 0D 0A 1A 0A` (8 bytes)
  - GIF: `47 49 46 38 (37|39) 61` (GIF87a / GIF89a)
  - JPEG: `FF D8 FF` (첫 3 bytes) — 012 attachment 용
- 흐름:
  1. MinIO `HeadObject` 로 크기 확인 (기존)
  2. `GetObject` range `bytes=0-15` fetch (16 bytes)
  3. MIME 별 expected magic 과 비교
  4. mismatch → 객체 즉시 삭제 + 400 `invalidMagicBytes`
- 적용 대상:
  - 037 `CustomEmojiService.finalize` (PNG / GIF)
  - 012 `AttachmentService.finalize` (PNG / GIF / JPEG)
- Int spec:
  - `magic-bytes-emoji.int.spec.ts` — PNG 헤더로 GIF mime 신청 → 거부
  - `magic-bytes-attachment.int.spec.ts` — JPEG mime 로 text 파일 업로드 → 거부
- shared-types `ErrorCodeSchema` 에 `invalidMagicBytes` 추가

### C. DS source of truth diff 재확인 + CI guard

**Diff 재확인:**

- 대상 4개 파일:
  - `apps/web/public/design-system/tokens.css`
  - `apps/web/public/design-system/components.css`
  - `apps/web/public/design-system/mobile.css`
  - `apps/web/public/design-system/icons.css`
- 037 의 `main=e6ee320` 기점으로 git log 검토 — 우회 변경 감지
- `index.html` 에 4개 파일 모두 `<link>` 돼 있는지 확인 (029 회귀 guard)

**CI workflow `.github/workflows/ds-protection.yml`:**

```yaml
name: ds-protection
on:
  pull_request:
    paths:
      - 'apps/web/public/design-system/**'
jobs:
  guard:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - name: Require [ds-ok] label in commit msg
        run: |
          if ! git log origin/${{ github.base_ref }}..HEAD --pretty=%B | grep -q '\[ds-ok\]'; then
            echo "DS files changed but no [ds-ok] tag in commit message"
            echo "DS files are the source of truth (memory: design-system-source-of-truth)"
            exit 1
          fi
```

**증거:**

- Workflow 파일 존재
- 시뮬레이션 PR (local 에서 임시 branch + diff → workflow run log 로 fail 확인, 이번 task 자체는 DS 파일 변경 없으므로 실제로는 pass)
- 메모리 `feedback_design_system_source_of_truth.md` 에 CI guard 링크 추가 한 줄

### D. develop → main auto-promote + Pane 1 auto-forward 16번째

표준 flow. 특히:

- emoji-gc 는 prod cron 이 이미 돌고 있음 → 배포 후 다음 스케줄에서 자동 반영
- magic-bytes 는 migration 없음 (runtime 검증만) — 단순 배포
- DS CI workflow 는 `main` 머지 시점부터 활성

## Scope (OUT)

- DS 파일 실제 수정
- 큰 feature (Voice / Group DMs / mecab-ko)
- orphan-gc 의 attachment 부분 리팩터링 (이미 012 에서 완성)
- `qufox_orphan_gc_*` metric 신규 추가 (있으면 재사용, 없으면 OUT)
- Alertmanager 배포
- 기타 누적 LOW/NIT (037 에서 5건 처리, 남은 건 039 이후)

## Acceptance Criteria (mechanical)

- `pnpm verify` green
- **A 검증**:
  - `scripts/backup/orphan-gc.sh --dry-run` 출력에 `prefix=emojis/` 섹션 존재
  - prod 1회 수동 실행 + stdout log 캡처
  - git diff `scripts/backup/orphan-gc.sh` 에 emoji 처리 코드 추가
- **B 검증**:
  - `apps/api/src/modules/storage/validate-magic-bytes.ts` 존재
  - `pnpm --filter @qufox/api test:int` green:
    - `magic-bytes-emoji.int.spec.ts`
    - `magic-bytes-attachment.int.spec.ts`
  - `ErrorCode.invalidMagicBytes` shared-types 에 추가 확인
- **C 검증**:
  - `.github/workflows/ds-protection.yml` 존재
  - Workflow local dry-run 성공 (GH Actions runner 또는 `act`)
  - `apps/web/index.html` 에 4개 DS css link 모두 존재 grep
  - 037~038 기간 DS 4파일 git diff 0 (우회 변경 없음)
- DS `mobile.css` / `tokens.css` / `components.css` / `icons.css`
  untouched (git diff 0)
- 3 artefacts: `038-*.md`, `038-*.PR.md`, `038-*.review.md`
- 1 eval: `evals/tasks/049-follow-up-sweep.yaml`
- Reviewer subagent 실제 스폰 + transcript token count 기록
- 직접 develop merge → main auto-promote via webhook
- `.deploy/audit.jsonl` last entry `exitCode=0` + sha matches main tip
- `GET https://qufox.com/api/readyz` 200 + idle-window 30s
- **Pane 1 auto-forward 16번째**
- FINAL REPORT 자동 출력, 포함:
  - develop/main SHA + exitCode + /readyz + idle + wall clock
  - 청크 A~C 산출물 표
  - emoji-gc dry-run 출력 캡처 (prefix=emojis 섹션)
  - magic-bytes int spec green 로그
  - DS guard workflow 파일 + 시뮬레이션 결과
  - Deferred TODO(task-038-follow-\*)
- Feature branch retained

## Prerequisite outcomes

- 037 merged + deployed (`e6ee320` main)
- 012 attachment storage + orphan-gc.sh cron
- Custom emoji MinIO upload flow (037-D)
- 029 DS css link 회귀 guard (index.html 에 mobile.css link)
- Loki + Promtail (로그 확인용, 036)

## Design Decisions

### 7일 grace period

emoji-gc 가 MinIO 업로드 완료 직후 DB finalize 가 지연될 가능성
(네트워크 hiccup / finalize 실패 재시도) 커버. 7일이면 충분히
안전. 012 attachment 도 동일 기준.

### magic-bytes 를 finalize 에 두는 이유

Presign PUT 은 client 가 직접 MinIO 로 업로드하므로 서버가 Content-Type
을 검증할 수 없다. Finalize 시점이 첫 서버측 검증 기회. GetObject
range 0-15 bytes 는 비용 무시할 수준.

### DS CI guard 방식 — commit msg tag

branch protection rule 대신 commit msg `[ds-ok]` tag 채택 이유:

- 의도적 변경 시 작성자가 명시적으로 선언
- Reviewer 가 tag 를 보고 추가 검토 trigger
- Auto-merge 봇도 tag 로 인지 가능
- `.github/CODEOWNERS` 까지는 오버엔지 — 지금은 단일 인 계정

### mismatch 시 객체 즉시 삭제

MinIO 에 잘못 업로드된 객체를 남기면 orphan-gc 가 7일 뒤 치우지만
, 악성 payload 가 7일 동안 존재. finalize 단계에서 mismatch 감지
시 MinIO `DeleteObject` 즉시 호출 + DB row insert skip.

### Workflow 시뮬레이션 방법

`act` (nektos/act) 로 local 검증이 이상적이나 NAS 에 없음. 대안:

- 임시 branch `ci-test-ds-protection` 에서 DS 파일 수정 + commit msg tag 없음 → PR → workflow fail 확인 → PR close
- 이 과정에서 실제 merge 안 함
- 대신 workflow 의 `run` 명령을 local bash 로 직접 실행해도 동등 검증

### orphan-gc 확장 vs 신규 script

별도 `emoji-orphan-gc.sh` 만들면 관리 포인트 증가. 012 가 이미
attachment prefix 순회 패턴을 갖고 있으니 prefix 배열에 emoji 추가
하는 방식이 덜 중복.

## Non-goals

- 새 feature
- DS 재디자인 / 파일 수정
- Voice / Group DMs / mecab-ko
- Custom emoji 기능 확장 (animated / cross-workspace)
- Attachment 처리 로직 전면 리팩터
- orphan-gc metric 신규 시스템

## Risks

- **magic-bytes 가 기존 attachment 를 깰 수 있음**: 012 에서
  JPEG 허용 / 검증 없음 상태였다면 프로덕션 업로드 중에
  false reject 가능. int spec 에 **실제 JPEG 파일 sample** 포함
  - deploy 후 smoke 로 실제 업로드 1회 확인
- **DS CI workflow 가 legitimate 변경 차단**: `[ds-ok]` tag 누락
  시 reviewer 가 수동으로 push 해야 함. PR.md 에 tag 사용법 명시
- **orphan-gc dry-run 오탐**: emoji prefix 의 DB 매핑 쿼리가 정확
  해야 함. `CustomEmoji.storageKey` 필드 사용 — 012 의 attachment
  IN-set 쿼리와 동일 패턴
- **MinIO range GET 비용**: object 당 16 bytes. 업로드 빈도 낮아
  무시 가능
- **GIF87a vs GIF89a**: 둘 다 허용 (6번째 byte `37` 또는 `39`). regex
  로 분기
- **PNG 변종 (MNG 등)**: 표준 PNG magic 만 허용. APNG 는 PNG magic
  과 동일하므로 pass (APNG 를 일반 PNG 로 취급 — 첫 프레임만 렌더
  되거나 브라우저가 애니메이션. 이번 task 는 이를 허용)
- **037 의 `CustomEmojiService` finalize 에 이미 HeadObject
  호출 존재**: 새 helper 와 중복되지 않게 `finalize` 메서드 안에
  서 HeadObject → range GET → magic 검증 순서로 정리

## Progress Log

- [x] UNDERSTAND — `scripts/backup/attachment-orphan-gc.sh` uses `DATABASE_URL` directly (bug: libpq rejects `?schema=public`); `CustomEmojiService.finalize` already has HEAD + size gate; `AttachmentService.finalize` ditto; `apps/web/index.html` has 4 DS `<link>` rows.
- [x] PLAN — B first (magic-bytes helper, S3 range GET, finalize wiring, int specs). Then A (orphan-gc emoji sweep + psql URL fix). Then C (workflow + memory note).
- [x] SCAFFOLD — empty `validate-magic-bytes.ts`, int test dirs, workflow yaml, orphan-gc heredoc-safe reshape.
- [x] IMPLEMENT — Chunks B → A → C landed; DATABASE_URL bug handled via `PGURL="${DATABASE_URL%%\?*}"`.
- [x] VERIFY — `pnpm --filter @qufox/api test` 79 green; `pnpm --filter @qufox/api test:int magic-bytes` 5 green (30s, testcontainer postgres + mocked S3); `pnpm --filter @qufox/shared-types test` 8 green; `pnpm --filter @qufox/web test` 38 green; API tsc clean; bash syntax clean.
- [x] OBSERVE — orphan-gc dry-run inside `qufox-backup` container: `emoji dry-run: scanned=0 would-delete=0 prefix=emojis/` — prod has no emoji blobs yet so the scan is clean. Workflow simulated locally: DS-touch without `[ds-ok]` → fail; with tag → pass. DS diff (037 tip `e6ee320` → feat HEAD) empty for all 4 files.
- [x] REFACTOR — none required; service changes stayed narrow.
- [ ] REPORT — develop merge → main auto-promote → FINAL REPORT + pane 1 forward 16th.
