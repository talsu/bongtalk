import { PERMISSIONS, has } from '@qufox/shared-types';

/**
 * S61 (D12 / FR-RM03): 커스텀 Role 기반 채널 권한 5단계 BigInt 계산(순수 함수).
 *
 * PRD 계산 순서(정본):
 *   ① @everyone 기본          → base(@everyone 역할 permissions)
 *   ② 역할 OR 합산            → 보유 역할들의 permissions 를 OR 누적
 *   ③ @everyone overwrite     → @everyone ROLE override(allow|deny)
 *   ④ 역할 overwrite          → 보유 역할 ROLE override(position 오름차순 적용)
 *   ⑤ 멤버 개별 overwrite     → USER override(allow|deny)
 * ADMINISTRATOR 비트 보유자는 ③~⑤ overwrite 검사를 전부 무시하고 모든 권한을
 * 가진다(채널 overwrite 면제 · ADR-4).
 *
 * 본 파일은 BigInt 도메인(ADR-4 카탈로그)에서 동작한다. 집행 enum(0xFF number
 * 도메인)과 분리된 신규 계산 경로이며, 입력은 모두 부호 없는 논리값(BigInt)으로
 * 정규화돼 들어온다고 가정한다(서비스 레이어가 fromStoragePermissions 로 변환).
 */

/** S61: 권한 계산에 필요한 단일 역할 입력. position 은 overwrite 적용 순서용. */
export interface ResolverRole {
  /** Role.id(UUID). @everyone 역할도 동일 id 체계. */
  id: string;
  /** 역할 기본 permissions(BigInt · 부호 없는 논리값). */
  permissions: bigint;
  /** 높을수록 상위. overwrite 는 position 오름차순(낮은 역할 먼저)으로 적용. */
  position: number;
  /** @everyone 역할 여부 — base/③ 단계 구분용. */
  isEveryone: boolean;
}

/** S61: 채널 overwrite(allow/deny) 한 쌍. principal 단위로 누적해 전달. */
export interface ResolverOverwrite {
  allow: bigint;
  deny: bigint;
}

export interface ResolveChannelPermissionsInput {
  /** @everyone 역할(항상 존재). */
  everyone: ResolverRole;
  /** 멤버가 보유한 @everyone 외 역할들(순서 무관 — 내부에서 position 정렬). */
  memberRoles: ResolverRole[];
  /** @everyone ROLE override(③). 없으면 {0n,0n}. */
  everyoneOverwrite?: ResolverOverwrite;
  /**
   * 역할별 ROLE override(④). roleId → overwrite. 적용은 보유 역할 중 override 가
   * 있는 것만, position 오름차순으로. (PRD: 역할 overwrite position 오름차순)
   */
  roleOverwrites?: Map<string, ResolverOverwrite>;
  /** 멤버 개별 USER override(⑤). 없으면 {0n,0n}. */
  memberOverwrite?: ResolverOverwrite;
}

/**
 * S61 (FR-RM03): 채널 유효 권한 마스크(BigInt)를 5단계로 계산한다.
 * ADMINISTRATOR 보유 시 즉시 전체 허용(overwrite 무시).
 */
export function resolveChannelPermissions(input: ResolveChannelPermissionsInput): bigint {
  // ① @everyone 기본 + ② 역할 OR 합산.
  let base = input.everyone.permissions;
  for (const r of input.memberRoles) {
    base |= r.permissions;
  }

  // ADMINISTRATOR 보유자는 overwrite(③~⑤)를 전부 무시하고 모든 권한을 가진다.
  if (has(base, PERMISSIONS.ADMINISTRATOR)) {
    return base;
  }

  let mask = base;

  // ③ @everyone overwrite — deny 먼저 빼고 allow 더하는 Discord 순서(allow 가 deny 를
  //    이김 within same principal: deny &~ 후 allow |).
  if (input.everyoneOverwrite) {
    mask = applyOverwrite(mask, input.everyoneOverwrite);
  }

  // ④ 역할 overwrite — 보유 역할 중 override 가 있는 것을, position 오름차순(낮은
  //    역할 먼저 → 높은 역할이 나중에 적용돼 우선)으로 적용. PRD "position 오름차순".
  const sorted = [...input.memberRoles].sort((a, b) => a.position - b.position);
  const roleOverwrites = input.roleOverwrites;
  if (roleOverwrites && roleOverwrites.size > 0) {
    // Discord 모델: 역할 overwrite 는 모든 deny 를 먼저 누적해 빼고 모든 allow 를
    // 누적해 더한다(역할 tier 내부에서 deny 가 allow 를 이기지 않도록 position
    // 순서대로 단계 적용). 여기서는 position 오름차순으로 각 역할 (deny→allow)를
    // 순차 적용해 상위 역할 allow 가 하위 역할 deny 를 덮을 수 있게 한다.
    for (const r of sorted) {
      const ow = roleOverwrites.get(r.id);
      if (ow) {
        mask = applyOverwrite(mask, ow);
      }
    }
  }

  // ⑤ 멤버 개별 overwrite — 최우선(가장 마지막 적용).
  if (input.memberOverwrite) {
    mask = applyOverwrite(mask, input.memberOverwrite);
  }

  return mask;
}

/** 한 principal 의 overwrite 적용: deny 제거 후 allow 부여(allow > deny within principal). */
function applyOverwrite(mask: bigint, ow: ResolverOverwrite): bigint {
  let next = mask & ~ow.deny;
  next |= ow.allow;
  return next;
}

/**
 * S61: 보유 역할들의 "유효 워크스페이스 권한"(채널 overwrite 이전, base) 을 계산한다.
 * 워크스페이스 레벨 권한 검사(MANAGE_ROLES, KICK 등 채널 무관 권한)에 쓴다.
 */
export function resolveWorkspacePermissions(
  everyone: ResolverRole,
  memberRoles: ResolverRole[],
): bigint {
  let mask = everyone.permissions;
  for (const r of memberRoles) {
    mask |= r.permissions;
  }
  return mask;
}
