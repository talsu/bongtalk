# 072 서버 백로그 — 진행 추적 (단일 출처)

072 데스크톱 오버홀(N0~N6) 종결 후, 슬라이스별로 "서버 의존 → 이월"로 미룬 백로그
(072-N6-progress.md §이월 백로그)를 서버 슬라이스로 순차 실행한다. 메가루프 프로토콜
동일: 구현(BE+FE) → 적대 리뷰 워크플로우 → fix-forward → standalone verify →
e2e/단위 게이트 → develop --no-ff(ls-remote 실측) → main 승격 → NAS 배포 → /readyz → REPORT.

## 슬라이스 진행표

| 슬라이스 | 범위                                                              | 상태    | develop  | main     |
| -------- | ----------------------------------------------------------------- | ------- | -------- | -------- |
| S-A      | DM 라우트 rate-limit 하드닝(visibility/mute/leave/members)        | ✅ 배포 | fa74cb69 | 82146c23 |
| S-B      | 보관(아카이브) 채널 사이드바 숨김 + 미읽음 요약 제외              | ✅ 배포 | 0ae5cc9a | 873c9b85 |
| S-C      | 워크스페이스 아이콘 업로드(presign/finalize) + joinMode 설정 편집 | ✅ 배포 | ce2a1581 | c76c0633 |
| S-D      | 채널 둘러보기 per-channel memberCount + isMember(가입/열기 분기)  | ✅ 배포 | 22ba9ca1 | 0fe51a81 |
| S-E      | 그룹 DM 미읽음 집계(listGroups unreadCount)                       | ✅ 배포 | b8eed59e | 12c85878 |
| S-F      | suppress-embed fine-grained 권한 plumbing(viewerPermissions)      | ✅ 배포 | a44e3ce8 | b1f55336 |
| S-G      | AutoMod 규칙 폼 분기 + 감사 로그 5열 DTO(target/reason)           | ✅ 배포 | 34452a97 | 0776926d |
| S-H      | 실시간 연결 불가 배너 + 세션 배너                                 | 🔄 진행 | —        | —        |
| S-I      | Unreads 미리보기 엔드포인트                                       | ⬜ 대기 | —        | —        |
| S-J      | 채널 권한 override 편집기                                         | ⬜ 대기 | —        | —        |

마이그레이션 없음(전부 기존 nullable 컬럼 재사용: iconUrl/joinMode/archivedAt/
ChannelPermissionOverride). DM visibility/mute/leave/members rate-limit 은 S-A 에 포함됨.

---

## S-C — 워크스페이스 아이콘 + 가입 모드 (FR-W01)

브랜치: `feat/bl-c-ws-icon-joinmode`

### 청크 표

| #   | 청크                                            | 파일                                                                                                                                                                                                                                      |
| --- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | joinMode 편집 BE 배선                           | `workspaces.service.ts` update() OWNER 게이트·Prisma data·discover 캐시 무효화 + `workspace.ts` UpdateWorkspaceRequestSchema.joinMode                                                                                                     |
| C2  | 워크스페이스 아이콘 BE(presign/finalize/delete) | `profile.ts` WS*ICON*\* 스키마 + `workspaces.service.ts` presignIcon/finalizeIcon/deleteIcon + presign-on-read(listMine/getWithMyRole) + 신규 `workspace-icon.controller.ts`(@Roles ADMIN + member/role guard + rate-limit) + module 등록 |
| C3  | FE 아이콘 업로드 + joinMode 편집                | `api.ts`(presign/finalize/delete) + `useWorkspaces.ts`(useUploadWorkspaceIcon/useDeleteWorkspaceIcon, uploadAvatarBlob 재사용) + `WorkspaceSettingsPage.tsx`(아이콘 섹션 + joinMode select + doSave) + `Shell.tsx`(prop 전달)             |
| C4  | 레일 아이콘 렌더                                | `WorkspaceNav.tsx`(데스크톱) + `MobileChannelList.tsx`(모바일) — iconUrl 있으면 img, 없으면 이니셜 폴백                                                                                                                                   |
| C5  | 테스트                                          | `ws-icon.spec.ts`(계약) + `workspaces-email-domains.spec.ts`(joinMode OWNER 게이트) + `WorkspaceSettingsPage.spec.tsx`(joinMode/아이콘 UI) + `workspaces-icon.service.spec.ts`(아이콘 서비스 분기 — 리뷰 fix-forward)                     |

### 설계 결정

- 저장: 기존 `Workspace.iconUrl` 컬럼에 **MinIO storageKey**(`ws-icons/<wsId>/<uuid>.png`)를
  넣고(=Channel.iconUrl 그룹DM·avatarKey 선례) 읽을 때 presigned GET(600s)으로 변환한다.
  마이그레이션 없음. 서버 리사이즈 없음(CSS object-fit).
- 권한: 아이콘 = ADMIN+(이름/설명과 동일 코스메틱 게이트). joinMode = OWNER 전용
  (visibility/category 선례).
- 업로드: presigned POST(전역 아바타 패턴) → MinIO 직접 POST(uploadAvatarBlob 재사용)
  → finalize(magic-byte + 크기 + MIME 사후검증).

### 적대 리뷰(wf_b20defa7-9fd · 10 에이전트·3각도) fix-forward

raw 7 → confirmed 6(전부 **LOW**, BLOCKER/HIGH/MEDIUM 0). aria-hidden 프리뷰 1건 기각.

- **LOW(수리)**: discover() 가 iconUrl(storageKey)을 presign 안 하고 raw 노출 →
  `presignDiscoverPage` 헬퍼로 HIT/MISS 양쪽 반환 직전 변환(캐시는 raw 유지).
- **LOW(수리)**: invites preview 도 동일 누락 → InvitesService 에 WorkspacesService 주입,
  `presignIconUrl`(public 승격) 재사용.
- **LOW(수리)**: PATCH iconUrl(z.string().url())이 storageKey 모델과 충돌(dual-write·
  orphan) → UpdateWorkspaceRequestSchema 에서 iconUrl 제거 + service update() iconUrl
  spread 제거. 아이콘 변경은 전용 엔드포인트 단일 출처.
- **LOW(수리)**: a11y input-label-guard — 숨긴 file input 라벨 누락 → aria-label 추가.
- **LOW(수리)**: 아이콘 서비스 메서드 단위 커버리지 부재(CLAUDE.md 100%) →
  `workspaces-icon.service.spec.ts` 신설(traversal/IDOR/magic/prev-key http 보존/
  멱등/presign passthrough).
- **LOW(이월)**: icon/joinMode 변경에 realtime fanout 없음 — 타 멤버 레일은 다음 refetch 시
  갱신(freshness gap, 선존 name/visibility PATCH 패턴 동일). 별도 슬라이스.
- **범위 외(이월)**: `text-[color:var(--danger)]` 미정의 토큰(N5 선존·프로젝트 전역
  4곳) — S-C 표면 아님, 별도 follow-up.

### 게이트

- standalone verify: **19/19 green** (lint + typecheck + unit + contract; webhook 8 / shared-types 35 /
  api 125 / web 231 test files). 컨테이너 단독 실행(리뷰 워크플로우와 분리 — 자원 경합 flake 회피).
- 머지/배포: develop `ce2a1581` (ls-remote 실측) → main `c76c0633` (ls-remote 실측) → NAS
  auto-deploy.sh exit 0 (api+web recreate · health-wait 200 · api/web smoke OK) → /readyz 200.
  배포 후 검증: api 컨테이너 라우트 매핑 로그에 `WorkspaceIconController {/workspaces/:id/icon}` +
  presign/PUT/DELETE 확인, presign 라우트 컨테이너 내부 호출 401(인증 보호) — live.
- 이월(LOW): icon/joinMode realtime fanout(선존 패턴) · `text-[color:var(--danger)]` 미정의
  토큰(N5 선존·전역 4곳·범위 외) → 별도 follow-up.

---

## S-D — 채널 둘러보기 memberCount + isMember (FR-CH-06)

브랜치: `feat/bl-d-channel-membercount`

### 청크 표

| #   | 청크         | 파일                                                                                                                                                                                                     |
| --- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | 둘러보기 DTO | `channel.ts` ChannelBrowseItemSchema(= ChannelSchema.extend memberCount/isMember) + ListBrowsableChannelsResponseSchema                                                                                  |
| D2  | 둘러보기 BE  | `channels.service.ts` listBrowsable(공개·비보관 채널 + groupBy memberCount + 호출자 isMember) + `channels.controller.ts` `@Get('browse')`(:chid 보다 먼저, member-only)                                  |
| D3  | 둘러보기 FE  | `api.ts` listBrowsableChannels + `useChannels.ts` useBrowsableChannels(+ join/leave 가 browse 캐시 무효화) + `ChannelBrowser.tsx` useBrowsableChannels 전환·memberCount 표시·isMember "열기"/"가입" 분기 |
| D4  | 테스트       | `channels-browse.spec.ts`(listBrowsable 분기 — 필터/매핑/스코프)                                                                                                                                         |

### 설계 결정 — 멤버십 의미

★공개 채널은 **모든 워크스페이스 멤버에게 항상 보인다**(listByWorkspace `!isPrivate → true`).
"가입"의 실체는 joinChannel 이 만드는 USER override **opt-in 마커(allow:0/deny:0)**다(allowMask>0
아님 — 리콘 오판 정정). 따라서 둘러보기의 멤버십 = USER override 행 존재. 사이드바 핫패스는
건드리지 않고 전용 `browse` 엔드포인트에서만 집계(groupBy + 호출자 행, 2쿼리·인덱스).

### 적대 리뷰(wf_f1ec39d2-8a3 · 9 에이전트·3각도) fix-forward

raw 6 → confirmed 5 (MEDIUM 1 + LOW 4).

- **MEDIUM(수리)**: memberCount/isMember 가 모든 USER override 행을 셈 → addChannelMemberOverride
  (ADMIN·공개 채널 게이트 없음)가 건 **순수 deny 제한 행(allow:0·deny>0)**을 멤버로 오집계 +
  비가입자를 isMember=true 로 표기. join 마커(deny:0)·grant(allow>0)는 멤버, 순수 deny 제한은
  비멤버로 분리 → `NOT: { allowMask:0, denyMask:{gt:0} }` 필터 추가(groupBy + 호출자 양쪽).
  (잔여 edge: 가입 후 deny 제한 걸린 사용자 — 드묾, 정밀 분리는 멤버십 마커 컬럼·마이그레이션 이월.)
- **LOW(수리)**: ChannelBrowser docblock stale(listChannels 기준) → listBrowsable 기준 갱신.
- **LOW(수리)**: 버튼 접근명 채널명 미연결(rotor 모호) → `aria-label` 채널명 합성(UnreadsView 선례).
- **LOW(수리)**: `disabled={join.isPending}` 가 "열기" 버튼까지 막음 → `!c.isMember && join.isPending`.
- **LOW(이월)**: `/browse` 페이지네이션 없음(전 공개 채널 반환) — listByWorkspace 동일 자세,
  현 규모 OK. 채널 수천 시 cursor + 서버 검색 별도 슬라이스.

### 게이트

- standalone verify: **19/19 green** (webhook 8 / shared-types 35 / api 126 / web 231 test files).
  1회 ImageMosaicGrid(무관 첨부 테스트) kernel4.4 타이밍 flake → 재실행 통과 확정.
- 머지/배포: develop `22ba9ca1` (ls-remote 실측) → main `0fe51a81` (ls-remote 실측) → NAS
  auto-deploy.sh exit 0 (api+web recreate · health-wait 200 · api/web smoke OK) → /readyz
  `{db:ok,redis:ok,outbox:idle}`. 배포 후 검증: api 로그 `Mapped {/workspaces/:id/channels/browse, GET}`,
  browse 라우트 컨테이너 내부 호출 401(인증 보호) — live.

---

## S-E — 그룹 DM 미읽음/멘션 집계 (FR-DM-15)

브랜치: `feat/bl-e-groupdm-unread`

### 청크 표

| #   | 청크                   | 파일                                                                                                                                                  |
| --- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | 그룹 DM 미읽음/멘션 BE | `direct-messages.service.ts` listGroups 에 unreadCount/mentionCount 상관 서브쿼리 추가(1:1 list() 패턴 미러) + `global-dm.controller.ts` 반환 타입    |
| E2  | FE 배지                | `useDms.ts` GroupDmListItem 필드 + `dmRows.ts` buildDmRows 그룹 행 카운트 배선 + `DmShell.tsx` 그룹 배지 0 하드코딩 제거(deriveDmBadgeCount 1:1 동일) |
| E3  | 테스트                 | `dmRows.spec.ts` grp 팩토리 필드 + 그룹 카운트 보존 테스트                                                                                            |

### 설계 결정

DM 도 Channel(type=DIRECT)이라 1:1 `list()` 가 이미 UserChannelReadState 기반 unreadCount/
mentionCount 를 집계한다(검증된 선례). 그룹 `listGroups()` 만 빠져 있었다 → **같은 술어**
(roots-only · deletedAt IS NULL · (createdAt,id) 읽음 커서 · mentionMatchSql)를 단일 raw
쿼리에 fold(N+1 회피). 신규 마이그레이션 없음. 모바일 DM 목록은 1:1 만 렌더(그룹 미렌더 —
선존 한계, S-E 스코프 외).

### 적대 리뷰(wf_a8d23d11-dd4 · 10 에이전트·3각도) fix-forward

raw → confirmed 3 (MEDIUM 1 + LOW 2).

- **MEDIUM(수리)**: 그룹 DM 미읽음 배지가 실시간 갱신 안 됨 — dispatcher `message.created` 가
  `['dm','list']` 만 무효화하고 `['dm','groups']` 미무효화 → 그룹 배지가 staleTime(15s)/focus
  전까지 stale(1:1 대비 비대칭). prefix `['dm']` 무효화로 넓혀 1:1·그룹 동시 갱신.
- **LOW(수리)**: DmShell docstring + dmRowBadge.ts 헤더 주석 stale("그룹=배지 없음 / 서버
  mentionCount 미제공") → 현행(서버가 1:1·그룹 모두 제공) 반영.
- **LOW(수리)**: listGroups mentionCount "항상 0" 주석 부정확(workspace-scoped 그룹은 비-0
  가능) → 명확화.

### 게이트

- standalone verify: **19/19 green** (첫 시도 + fix-forward 후 재확인 — webhook 8 / shared-types 35 /
  api 126 / web 231).
- 머지/배포: develop `b8eed59e` (ls-remote 실측) → main `12c85878` (ls-remote 실측) → NAS
  auto-deploy.sh exit 0 (api+web recreate · health-wait 200 · api/web smoke OK) → /readyz
  `{db:ok,redis:ok,outbox:idle}` · 두 컨테이너 healthy.

---

## S-F — suppress-embed fine-grained 권한 plumbing (FR-RC08 / N0-F4)

브랜치: `feat/bl-f-suppress-embed-perm`

### 갭(F4)

서버 suppressEmbed 게이트(messages.controller.ts:756 = 작성자 OR `Permission.DELETE_ANY_MESSAGE`·채널
override fold 포함)는 정확하나, FE 는 `canSuppressEmbed = !!workspaceId && !tmp && (authorId===me ||
viewerRole OWNER/ADMIN)` 로 **클라 추정** — 채널 override 무시. MEMBER override 보유자 false neg /
OWNER deny override false pos(클릭 시 403). FE 가 viewer 의 채널 권한을 알 방법이 없었음.

### 설계 — 노출 위치 결정 = (B) ListMessagesResponse

채널 스코프 권한을 **메시지 목록 응답**에 페이지당 1개 싣는다(설계 시 후보 A=단일채널GET 보다
B 채택 — MessageList 가 useMessageHistory 를 이미 소비해 **신규 쿼리 0**, 후보 A 는 useChannel 훅
신설 필요). 작성자 체크만 per-msg(FE authorId 보유).

### 청크 표

| #   | 청크         | 파일                                                                                                                                             |
| --- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1  | 응답 계약    | `message.ts` ViewerChannelPermissionsSchema + ListMessagesResponse.viewerPermissions(optional·롤아웃/DM 폴백)                                    |
| F2  | BE 권한 해석 | `messages.controller.ts` list() 가 채널 viewer canManageMessages = hasPermission(DELETE_ANY_MESSAGE) 1회 해석(DM/채널부재 false) 후 응답 포함    |
| F3  | FE 분기      | `suppressEmbedPerm.ts` deriveCanSuppressEmbed 순수 헬퍼 + `MessageList.tsx` history 페이지에서 canManageMessages 읽어 분기(viewerRole 추정 제거) |
| F4  | 테스트       | `suppressEmbedPerm.spec.ts`(엣지) + `message.spec.ts`(계약 safeParse)                                                                            |

### 적대 리뷰(wf_7d904340-7a7 · 13 에이전트·3각도) fix-forward

raw → confirmed 3 (전부 **LOW**, BLOCKER/HIGH/MEDIUM 0).

- **LOW(수리)**: 채널 권한 override 변경 후 메시지 리스트 stale → suppress 버튼 일시 오노출/오숨김
  (서버 재검증으로 안전하나 UX). useUpsertChannelOverride invalidate 에 `qk.messages.list` 추가.
- **LOW(수리)**: deriveCanSuppressEmbed spec precedence 엣지 미커버(tmp+권한자 / DM+tmp+작성자) → 케이스 추가.
- **LOW(수리)**: viewerPermissions 계약 회귀망 부재 → message.spec safeParse 샘플 추가(int 단언은 게이트 외 이월).

### 게이트

- standalone verify: **19/19 green** (첫 시도 + fix-forward 재확인 — webhook 8 / shared-types 35 /
  api 126 / web 232). 1회 ImageMosaicGrid(무관 첨부) kernel4.4 타이밍 flake → 재실행 통과.
- 머지/배포: develop `a44e3ce8` (ls-remote 실측) → main `b1f55336` (ls-remote 실측) → NAS
  auto-deploy.sh exit 0 (api+web recreate · health-wait 200 · smoke OK) → /readyz `{db:ok,redis:ok,outbox:idle}`.

---

## S-G — AutoMod 폼 분기 + 감사 로그 5열 (FR-RM10b / FR-RM12 · N5-3)

브랜치: `feat/bl-g-automod-audit`

### 청크 표

| #   | 청크                     | 파일                                                                                                                                                             |
| --- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | AutoMod 폼 type 분기(FE) | `AutoModPanel.tsx` triggerType select(생성 선택·수정 고정) + KEYWORD/MENTION_SPAM/REPEAT_SPAM 조건부 필드 + discriminated-union body 조립 + 리스트 트리거별 요약 |
| G2  | 감사 로그 5열 BE         | `audit.ts` AuditLogEntry.target/reason(optional) + `audit.service.ts` listAuditLogs actor/target username batch 해석 + extractAuditReason(details.reason 평탄화) |
| G3  | 감사 로그 5열 FE         | `AuditLogPanel.tsx` 5열(시각·실행자·액션·대상·사유) — target username/축약id·reason 행                                                                           |
| G4  | 테스트                   | `audit.spec`(target/reason 계약) + `extract-audit-reason.spec`(엣지) + `audit-service.spec`(해석/분기) + `AutoModPanel.spec`(spam 폼 분기)                       |

### 설계 결정

- AutoMod: shared-types/BE 는 이미 3 트리거(discriminated union) 완비 — FE 만 KEYWORD 전용이었음.
  triggerType 은 생성 시 선택, 수정 시 고정(서버 미지원). spam 은 임계값+윈도, KEYWORD 는 키워드 칩+매칭모드.
- 감사 로그: targetId 가 사용자면 username 해석(actor+target 단일 User batch 쿼리·N+1 회피),
  아니면 null(FE targetId 폴백). reason 은 details.reason 평탄화. 마이그레이션 없음.

### 적대 리뷰(wf_e48274bf-490 · 8 에이전트·3각도) fix-forward

raw 5 → confirmed 5 (MEDIUM 2 + LOW 3).

- **MEDIUM(수리)**: addKeyword 가 REGEX 패턴도 소문자화 → 대소문자 의존 정규식 침묵 변형.
  `matchMode==='REGEX'` 면 trim 만(서버 normalizeRegexPatterns 보존과 정합).
- **MEDIUM(수리)**: listAuditLogs target/actor/reason 해석 경로 단위 미커버 → audit-service.spec 에
  실재 user·비-사용자 target·details.reason 케이스 추가(4경로 assert).
- **LOW(수리)**: spam 임계값/윈도 정수 검증 부재(소수 통과→서버 400) → spamValid Number.isInteger + step={1}.
- **LOW(수리)**: audit.ts 게이트 주석 isAdministrator 드리프트 → ROLE_RANK 게이트로 정정.
- **LOW(수리)**: AutoModPanel spam 폼 분기 컴포넌트 미커버 → AutoModPanel.spec spam 케이스 2건.

### 게이트

- standalone verify: **19/19 green** (fix-forward 후 — webhook 8 / shared-types 35 / api 127 / web 232).
  1회 input-label-guard(spam input aria-label 이 onChange `=>` 뒤라 가드 attr 스캔서 절단 + 신규
  label 이 timeout/action 의 wrapping-label 1500자 균형 깨짐) → 폼 컨트롤 6개 aria-label 을 onChange 앞으로 이동해 수리.
- 머지/배포: develop `34452a97` (ls-remote 실측) → main `0776926d` (ls-remote 실측) → NAS
  auto-deploy.sh exit 0 (api+web recreate · health-wait 200 · smoke OK) → /readyz `{db:ok,redis:ok,outbox:idle}`.

---

## S-H — 실시간 연결 failed 배너 + 세션 종료 통지 (N6-3 / FR-AUTH-55)

브랜치: `feat/bl-h-connection-banner`

### 청크 표

| #   | 청크                      | 파일                                                                                                                                                                                                                                                                  |
| --- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1  | 연결 failed 종단 배너(FE) | `useRealtimeConnection.ts` RealtimeStatus +'failed'(socket.io `reconnect_failed` = reconnectionAttempts 10 소진 종단) + `computeConnectionBanner.ts` failed level(reloadable·우선순위 offline>failed>disconnected>replaying) + `ConnectionBanner.tsx` "새로고침" 액션 |
| H2  | 세션 종료 통지(FE)        | `lib/sessionEndNotice.ts` mark/consume/clear(StrictMode 1-shot) + `lib/api.ts` forceLogout(reason)·401→markSessionEnded('expired') + `useRealtimeConnection` session:revoked→forceLogout('revoked') + `LoginPage.tsx` consume→배너                                    |
| H3  | 테스트                    | `computeConnectionBanner.spec`(failed) + `ConnectionBanner.spec`(reload 버튼) + `sessionEndNotice.spec` + `LoginPage.spec`(notice)                                                                                                                                    |

### 설계 결정 / 스코프

- **연결 failed**: 순수 FE — 상태(useRealtimeConnection)는 이미 존재. socket.io Manager 의
  `reconnect_failed`(자동 재연결 종단)를 'failed' 로 매핑해 일시 'disconnected'와 구분, 새로고침 안내.
  복구는 reload 또는 로그인 세션 변경(user.id)뿐(Manager 자동 재시도 없음 — 종단).
- **세션 통지**: 기존 이벤트만 사용 — 401 리프레시 실패='expired', 서버 session:revoked(계정
  비활성화 등)='revoked'. 강제 로그아웃 직전 사유를 sessionStorage 에 적고 LoginPage 가 1회 안내.
  신규 서버 이벤트 불요.
- **★범위 한정(이월)**: 현재 'revoked' 통지원은 session:revoked(계정 비활성화)뿐이다. **FR-AUTH-56
  "다른 기기 per-session 강제 로그아웃 푸시"**(세션 레지스트리 + 대상 세션에 WS push)는 신규 서버
  기능이라 본 슬라이스 OUT — 별도 슬라이스 이월. 본 슬라이스는 이미 발생하는 강제 로그아웃을
  사용자에게 *설명*하는 데 한정한다.

### 적대 리뷰(wf_5c0c9cb6-3a4 · 13 에이전트·3각도) fix-forward

raw 10 → confirmed 8 (MEDIUM 2 + LOW 6, 일부 중복).

- **MEDIUM(수리)**: 자발적 계정 비활성화가 session:revoked(응답보다 먼저 도착)로 markSessionEnded
  ('revoked')를 적어 "다른 기기/관리자" 배너 오발 + 성공 토스트와 모순 → `clearSessionEndedReason()`
  추가, AdvancedSettingsPage 비활성화 성공 직후 호출.
- **MEDIUM(수리)**: 연결 배너 saturated 배경(warn/danger-400)+text-strong 다크테마 AA 미달 →
  bg-elevated + 테마-aware var(--text) + 레벨 하단 컬러 보더로 재색(AA 보장·offline 톤 무고지 변경도 해소).
- **LOW(수리)**: useRealtimeConnection 'failed' 주석 자동복구 과장 → 종단 사실로 정정 ·
  StrictMode 이중 consume(dev 배너 소실) → sessionEndNotice 모듈 1-shot 캐시 · ConnectionBanner
  렌더 테스트 부재 → spec 신설 · 'revoked 한정'/FR-AUTH-56 이월을 본 문서에 사실화(이 절).

### 게이트

- standalone verify: **19/19 green** (첫 시도 — webhook 8 / shared-types 35 / api 127 / web 233).
- 머지/배포: (채움)
