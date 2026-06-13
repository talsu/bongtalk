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
| N1-G | 게이트: 데스크톱 e2e(dm) + standalone verify + 적대 리뷰 | todo | |
| N1-D | develop 머지→main 승격→배포→/readyz→REPORT | todo | |

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
