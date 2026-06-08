/**
 * FR-P09 (task-068 · S95): 역할기반 멤버목록 hoist 계산(순수 함수).
 *
 * 종전 S27 은 OWNER/ADMIN 을 단일 '운영진'(staff) 그룹으로 하드코딩했으나, S61 커스텀
 * Role 로 차단이 해소되어 Role.hoistInMemberList=true 역할마다 별도 그룹을 만든다
 * (Discord per-role hoist). 멤버가 여러 hoisted 역할을 보유하면 **최상위(position 최대)
 * 1개** 그룹에만 들어간다(중복 그룹 없음 · Discord 동작). 동일 position tie 는 roleId
 * 사전순으로 결정해 안정적이다.
 *
 * I/O 만 다루는 순수 함수라 DB/Prisma 없이 단위 테스트할 수 있다(members.service 는
 * role + MemberRole 을 각각 1회 배치 조회해 이 함수에 넘긴다 — N+1 없음).
 */

/** hoisted 역할 1개(hoistInMemberList=true). */
export interface HoistedRoleInfo {
  roleId: string;
  name: string;
  position: number;
  /** #RRGGBB 또는 null(색상 없음). */
  colorHex: string | null;
}

/**
 * hoisted 역할 목록을 **표시 순서**(position DESC, tie 는 roleId ASC)로 정렬한다.
 * hoist 그룹 출력 순서와 멤버의 최상위 역할 선택의 단일 정렬 기준이다.
 */
export function sortHoistedRoles(roles: HoistedRoleInfo[]): HoistedRoleInfo[] {
  return [...roles].sort((a, b) => {
    if (a.position !== b.position) return b.position - a.position; // position DESC
    return a.roleId < b.roleId ? -1 : a.roleId > b.roleId ? 1 : 0; // tie-break roleId ASC
  });
}

/**
 * 한 멤버가 보유한 hoisted roleId 집합 중 **최상위(position 최대 · tie 는 roleId ASC)**
 * roleId 를 고른다. hoisted 역할을 하나도 안 가지면 null(→ 호출부가 status 그룹으로
 * 분류). `sortedHoistedRoles` 는 미리 sortHoistedRoles 로 정렬된 목록이어야 한다.
 */
export function pickTopHoistRoleId(
  sortedHoistedRoles: HoistedRoleInfo[],
  memberHoistedRoleIds: ReadonlySet<string>,
): string | null {
  if (memberHoistedRoleIds.size === 0) return null;
  // sortedHoistedRoles 가 표시 순서(최상위 먼저)라, 멤버가 보유한 첫 역할이 최상위다.
  for (const role of sortedHoistedRoles) {
    if (memberHoistedRoleIds.has(role.roleId)) return role.roleId;
  }
  return null;
}
