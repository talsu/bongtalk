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
| S-C      | 워크스페이스 아이콘 업로드(presign/finalize) + joinMode 설정 편집 | 🔄 진행 | —        | —        |
| S-D      | 채널 둘러보기 per-channel memberCount + isMember(가입/열기 분기)  | ⬜ 대기 | —        | —        |
| S-E      | 그룹 DM 미읽음 집계(listGroups unreadCount)                       | ⬜ 대기 | —        | —        |
| S-F      | suppress-embed fine-grained 권한 plumbing(viewerPermissions)      | ⬜ 대기 | —        | —        |
| S-G      | AutoMod 규칙 폼 분기 + 감사 로그 5열 DTO(target/reason)           | ⬜ 대기 | —        | —        |
| S-H      | 실시간 연결 불가 배너 + 세션 배너                                 | ⬜ 대기 | —        | —        |
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

- standalone verify: (배포 후 채움)
- 머지/배포: (채움)
