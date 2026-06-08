# Task 068 — FR-P09 역할 기반 멤버목록 hoist (S95)

## Context

FR-P09(P1, S27 partial): "역할 hoistInMemberList ON 시 해당 역할 멤버가 별도 상단 그룹으로
표시. 그룹 내 온라인 멤버만 기본 표시."

**현재 상태(S27)**: 커스텀 역할 부재로 **OWNER/ADMIN 을 단일 '운영진'(staff) 그룹으로 하드코딩**
(`HOISTED_ROLES` 상수 + `key:'staff'`). S27 주석이 "hoistInMemberList 컬럼/커스텀 역할은 역할
시스템 슬라이스로" 라 명시한 placeholder. **S61 커스텀 Role 로 차단 해소** → 역할기반 완성 가능.

## Scope

### IN

**BE — 역할 hoist 컬럼 + 동적 그룹 계산**

1. **Migration `20260632000000_frp09_role_hoist`**: `Role.hoistInMemberList Boolean @default(false)`.
   **시스템 역할 backfill**: OWNER·ADMIN 의 hoistInMemberList=true(현 '운영진' 동작 보존),
   MODERATOR/MEMBER/GUEST=false. (커스텀 Role 은 default false.) forward-safe(컬럼 추가+UPDATE).
   schema.prisma Role 에 필드 추가.
2. **`members.service.ts`** hoist 계산 교체(하드코딩 `HOISTED_ROLES` 제거):
   - 워크스페이스의 `Role where hoistInMemberList=true`(position DESC) 로드 + 그 멤버 assignment.
   - 각 멤버의 **최상위(position 최대) hoisted 역할**로 그룹 결정(Discord — 다중 hoisted 역할 시
     최상위 1개 그룹만·중복 없음).
   - **온라인만 hoist**(PRD "그룹 내 온라인 멤버만 기본 표시"): status≠offline 멤버만 hoist 그룹에.
     hoisted 역할 보유여도 **offline 이면 offline status 그룹으로** 강등(includeOffline 정책 동일 적용).
   - hoist 그룹 = 역할별 1개, position DESC 정렬, 그룹 내 online-first(기존 sortGroup 재사용).
   - hoisted 역할 없는 멤버 → 기존 status 그룹.
   - INVISIBLE 마스킹(FR-P12)·커서 페이지네이션 기존 정책 보존.
3. **shared-types `workspace.ts`**: `HoistGroupSchema.key` `z.literal('staff')` → `z.string()`(roleId).
   label=역할명. color 필드(역할 colorHex) 추가 고려(FE 그룹 헤더 틴트·optional). `HOISTED_ROLES`
   상수 제거 또는 deprecated. S27 주석 갱신.

**BE — Role CRUD 토글**

4. **roles create/update**(roles.service + DTO): `hoistInMemberList?: boolean`(mentionable 패턴 동형).
   shared-types CreateRoleRequestSchema/UpdateRoleRequestSchema/RoleSchema 에 추가.

**FE**

5. **`MemberColumn.tsx`**: hoist[] 를 이미 generic(label-driven) 렌더 — per-role 그룹 자동 대응.
   그룹 헤더에 역할명(label)·역할 색(있으면 colorHex 틴트) 적용. 'staff' 하드코딩 의존 제거 확인.
6. **역할 편집 UI**: hoistInMemberList 토글(mentionable 토글 옆·있으면). 최소.

**TEST**

- unit: hoist 그룹 계산(최상위 hoisted 역할 선택·offline 강등·online-first·다중 hoisted 역할 dedup).
- int(`members-grouped` 갱신 + 신규): 기본 OWNER/ADMIN backfill → 각자 그룹 / 커스텀 역할
  hoistInMemberList=true → 그 역할 그룹 노출 / offline hoisted 멤버 → offline 그룹 강등 /
  hoistInMemberList=false 역할 → status 그룹. Role CRUD hoist 토글 int.

### OUT (후속/Non-goals)

- **모바일 MobileMembers hoist 미적용**(S27 carryover·2그룹 online/offline 유지) — 모바일 parity 슬라이스.
- off-viewport 멤버 dot stale(viewport 구독 한정·기존 carryover).
- 멤버목록 email PII 노출(선제존재·별 PII-hardening).
- FR-P10/P11/P12 등 인접 presence FR(별 슬라이스).

## Acceptance Criteria (기계 검증)

- [ ] `Role.hoistInMemberList`(migrate deploy green) + OWNER/ADMIN backfill=true.
- [ ] hoistInMemberList=true 역할 멤버(온라인) → 그 역할명 hoist 그룹(position DESC). 다중 hoisted
      역할 보유 멤버는 최상위 1개 그룹만.
- [ ] hoisted 역할 멤버라도 offline → offline status 그룹(hoist 그룹엔 online 만).
- [ ] hoistInMemberList=false 역할/무역할 멤버 → status 그룹(기존).
- [ ] Role create/update 로 hoistInMemberList 토글 가능.
- [ ] 기본(OWNER/ADMIN backfill) 멤버목록이 회귀 없이 OWNER·ADMIN 을 hoist(단일 staff→per-role 그룹 전환).
- [ ] verify(lint+typecheck+unit+contract) green · 신규 int green(container standalone).

## Risks

- **UX 변경(의도)**: 단일 '운영진' → per-role 그룹(OWNER·ADMIN 분리). S27 주석이 단일 그룹을
  placeholder 로 명시 + PRD 가 per-role 별도 그룹 요구 → 의도된 진화. members-grouped int 갱신.
- HoistGroupSchema.key 'staff'→string 계약 변경: FE 는 key 를 React key 로만 쓰고 분기 없음
  (label 표시) → 무영향. 'staff' 리터럴 의존처 grep 확인.
- migration backfill: 기존 워크스페이스의 OWNER/ADMIN 시스템 Role 에 UPDATE — 멱등·forward-safe.
- 다중 hoisted 역할 멤버 그룹 결정(최상위 position) — 정렬 안정성(동일 position 시 tie-break).

## DoD

체크리스트 green + standalone container `pnpm verify` + 신규 int green + 7차원 리뷰 fix-forward +
fr-matrix FR-P09→done + handoff LIVE + 자율 배포(auto-deploy.sh·SHA 없이) + `/readyz=200` + 디스크 모니터.
