# 072-N1 진행 — DM 데스크톱 셸 완성

> 단일 진실원. 계획: `docs/tasks/072-desktop-uiux-overhaul.md` N1 절. 감사: `docs/audits/2026-06-13-desktop-uiux-audit.md`.
> 규약·검증·배포 071/N0 동일. 브랜치 feat/072-n1-dm-desktop-shell (develop 8efdb6b 기점).
> DS 4파일 frozen. 데스크톱 e2e = apps/web/e2e/{messages,dm,...}.

## 정찰 결론 (2026-06-13)

- **백엔드 100% 완비**: `global-dm.controller` 가 createGroupDm·listGroups(`?q=`)·
  leaveGroup·setVisibility(HIDDEN/VISIBLE)·setMute(mutedUntil 기간)·addParticipants·
  rename·icon 전부 제공. N1 은 순수 프론트 배선.
- **그룹 DM 프론트는 데스크톱·모바일 양쪽 통째 dormant**: `useDmGroupList` 훅은 존재하나
  어떤 셸도 소비 안 함. MobileDmList 도 1:1 만(NewDmSheet 단일 친구). 미러할 레퍼런스 없음 → net-new.
- **그룹 DM 채널 표현**: `type=DIRECT` + `gdm:` name prefix, channelId 로 식별(단일 otherUserId 없음).
  → 열기 라우트는 userId 가 아닌 channelId 기반 필요(`/dm/g/:channelId` 신설).
- **추가 필요 훅**: useCreateGroupDm · useSetDmVisibility · useLeaveGroupDm · useSetDmMuteUntil(기간).
  기존 useSetDmMute 는 mutedUntil:null 하드코딩.

## 청크

| 청크 | 내용 | 상태 | 커밋 |
| ---- | ---- | ---- | ---- |
| N1-1 | 훅(group create/visibility/leave/mute-until) + DmShell 그룹 행 렌더(아바타 스택·displayName‖참여자명·멤버수) 1:1 과 lastMessageAt DESC 병합(buildDmRows) + `/dm/g/:groupId` 라우트로 그룹 대화 열기 (HIGH) | green | |
| N1-2 | 새 DM/그룹 생성 모달(Dialog) — 헤더 버튼 → 받는사람 멀티셀렉트(친구·칩) → 1명=useCreateOrGetDm·2+=useCreateGroupDm (HIGH) | green | |
| N1-3 | ⋯/우클릭 메뉴 확장 — 숨기기(visibility HIDDEN)·그룹 나가기(group only)·뮤트 기간 서브메뉴(6종, Dropdown Sub 신설) 또는 뮤트 해제 (HIGH) | green | |
| N1-4 | DM 검색 서버 q 전달(250ms 디바운스, 1:1+그룹 동일 q·useDmList/useDmGroupList 시그니처 확장) (LOW/MED) | green | |
| N1-G | 게이트: 데스크톱 e2e(dm) + standalone verify + 적대 리뷰(wfbfalyt8) | green | 90e1219·fa3f538 |
| N1-D | develop 머지→main 승격→배포→/readyz→REPORT | todo | |

## N1-G 적대 리뷰(wfbfalyt8 — 30 에이전트·6각도·1-vote·critic) fix-forward

raw 23 → confirmed 16 / plausible 1. HIGH 들은 검증 중 이미 수리돼 대부분 REFUTED(수리 확증).

**수리 완료(fix-forward 90e1219·fa3f538):**

- **HIGH×2**: 열린 그룹을 q/가시성-필터된 목록이 아니라 `useDmGroupMembers`(멤버 게이트)로
  독립 해석 → 검색 중 그룹 언마운트·숨긴 그룹 딥링크 무한로딩 차단. 비멤버 딥링크 not-found 폴백.
- **MEDIUM**: /dm/g(groupId 누락) UUID 가드 · 아바타 스택 본인 제외 · 그룹 멤버수 행 aria-label
  포함 · 컨텍스트 메뉴 트리거 accname 에 대화명 · 검색 시 열린 대화 표시명 퇴화 방지(labelCache).
- **★createDm 폭주(e2e 발견·리뷰 미포착)**: useMutation 매-렌더 정체성 변경 → by-user 해소 전
  createOrGet 무한 재발사 → 201 폭주 + hiddenAt 복원으로 '숨기기' 무력화. userId 당 1회 ref 가드.
- **LOW**: 메뉴 항목 선택 후 닫힘 · 열린 대화 숨기기/나가기 시 /dm 이동 · 모달 pending 가드 ·
  그룹 2줄 행 spacious(40px) 클리핑 방지 · qf-chip(no-op) 제거 · useSetDmMute 데드코드 제거 ·
  친구 섹션 검색어 클라 필터(critic — DM 만 필터되던 비일관 해소).

**이월(문서화·N5/서버):**

- 그룹 행 미읽음 배지/aria 부재 — 서버 listGroups 가 unreadCount 미제공이 근인 → **서버 슬라이스**
  필요(그룹 unread 집계). 시각·AT 양쪽 부재라 추후 서버 확장 시 동시 수리.
- visibility/mute/leaveGroup/group-members GET rate-limit 부재(defense-in-depth, 전부 멤버게이트)
  → **N5/보안 패스**(rename 패턴 따라 this.rate.enforce 추가; API 스코프).
- testid 가 row.title 키잉(동일 displayName 충돌 시 latent flaky — 현 e2e 는 stamp 유니크라 무영향) ·
  openRow direct 분기 silent no-op(계약위반 시만) · Avatar status 닷 SR(기존 Avatar 프리미티브) → 노트.

## 구현 메모

- 신규 파일: `features/dms/dmRows.ts`(buildDmRows·groupDmTitle·MUTE_DURATION_OPTIONS·muteUntilIso 순수 로직, +spec 10) · `e2e/dms/n1-desktop-group-shell.e2e.ts`(게이트).
- DS 프리미티브 추가(CSS 무수정): `DropdownSub/SubTrigger/SubContent`(Radix 래핑, qf-menu 재사용) — 뮤트 기간 서브메뉴용.
- 그룹 행 unread 배지: 서버 listGroups 가 unread/mention 미제공 → 배지 없음(뮤트 회색은 channelId 공유로 가능). 카운트 노출은 서버 확장 후속.
- 친구 행 보조정보(@핸들·상태 텍스트) 정합은 FriendsPage 소관 → N5 로 이관(DmShell 친구 행은 프레즌스 닷 유지).
- 모바일 회귀: MobileDmList 무변경(1:1 경로 보존), `/dm/g/:groupId` 모바일 진입 시 /dms 폴백.

## 노트

- 모바일 그룹 DM 은 N1 scope 밖(데스크톱 전용) — `/dm/g/:channelId` 모바일 진입 시 /dms 로 graceful redirect.
- 공유 컴포넌트(MessageColumn) 그룹 DM 렌더: channelId + channelName(displayName‖참여자) + extraNames(전 참여자) 주입. 메시지 라우트 `/me/dms/:channelId/messages` 가 group(DIRECT) 도 멤버게이트로 처리.
- 모바일 회귀 가드: MobileDmList 무변경 유지(1:1 경로 보존).
