import { Prisma } from '@prisma/client';

/**
 * S47 fix-forward (BLOCKER-4 · security): READ-비트 가시성 5단계 fold 의 단일 출처.
 *
 * 종전엔 UnreadService.readBitVisibleSql(private 메서드)·MyThreadsService(인라인
 * 복제)·MeNotificationBadgesService(2단계 union 근사) 가 제각각의 가시성 술어를
 * 들고 있어, 같은 비공개 채널에 대해 다른 결과를 냈다(badges 가 user DENY > role
 * ALLOW 경계를 깨 private 채널을 과대/과소 카운트). 본 모듈이 PermissionMatrix.
 * effective 와 동일 우선순위의 5단계 fold 를 SQL fragment 로 단일 정의하고,
 * rail(UnreadService)·badges·ACK 가 모두 이걸 참조해 동일 truth-source 를 쓴다.
 *
 *   base      = isPrivate ? (hasExplicitRead ? READ : 0) : READ
 *   read_bit  = (((base | roleAllowREAD) & ~roleDenyREAD) | userAllowREAD)
 *                                                         & ~userDenyREAD
 *   visible   = (isPrivate = false) OR (read_bit <> 0)
 *
 * hasExplicitRead = ((userAllow | roleAllow) & READ) — 비공개 채널은 READ 비트가
 * 명시적으로 ALLOW 돼야 base 가 열린다(비-READ grant 가 가시성을 누설하지 않음).
 *
 * OWNER short-circuit 은 하지 않는다(UnreadService 와 정합) — OWNER 도 5단계 fold
 * 를 통과한다. OWNER 는 ROLE_BASELINE 이 READ 를 포함하므로 명시 DENY 가 없으면
 * 자동으로 보이고, 명시 DENY 가 있으면 PermissionMatrix.effective 처럼 그것을
 * 존중한다(OWNER 무조건 가시 단락이 DENY 를 깨지 않게).
 *
 * `refs` 는 principalType 별 ALLOW/DENY 를 bit_or 한 컬럼 fragment(예 `o.role_allow`)
 * 와 isPrivate 컬럼 fragment 를 가리킨다(호출부가 바인딩).
 */
export function readBitVisibleSql(refs: {
  isPrivate: Prisma.Sql;
  roleAllow: Prisma.Sql;
  roleDeny: Prisma.Sql;
  userAllow: Prisma.Sql;
  userDeny: Prisma.Sql;
}): Prisma.Sql {
  const { isPrivate, roleAllow, roleDeny, userAllow, userDeny } = refs;
  return Prisma.sql`(
    ${isPrivate} = false
    OR (
      (
        (
          (
            (CASE
               WHEN ((COALESCE(${userAllow}, 0) | COALESCE(${roleAllow}, 0)) & 1) > 0 THEN 1
               ELSE 0
             END)
            | (COALESCE(${roleAllow}, 0) & 1)
          )
          & ~(COALESCE(${roleDeny}, 0) & 1)
        )
        | (COALESCE(${userAllow}, 0) & 1)
      )
      & ~(COALESCE(${userDeny}, 0) & 1)
    ) > 0
  )`;
}

/**
 * S62 (FR-RM03): ROLE-principal override 매칭 술어 단일 출처. 채널 override 의
 * `principalType='ROLE'` 행은 시스템 역할 리터럴(레거시 `principalId`=OWNER/ADMIN/…)
 * 또는 커스텀 Role.id(UUID)를 담는다. 가시성/배지/멘션 read-path 가 멤버의 시스템
 * 역할 리터럴만 매칭하면 커스텀 Role 채널 override 가 무시돼, 커스텀 Role 로만
 * READ 가 부여/박탈된 비공개 채널의 배지가 leak/누락된다.
 *
 * 이 헬퍼는 `cpo."principalId"` 가 (a) 멤버의 시스템 역할 리터럴(`roleLiteral`
 * fragment, 예 `mm.role::text`) 또는 (b) 멤버가 보유한 커스텀 Role UUID 집합
 * (MemberRole 서브쿼리) 중 하나와 일치하는지를 검사하는 술어를 만든다.
 *
 * `roleLiteral` 은 호출부가 바인딩하는 SQL fragment(멤버 시스템 역할 ::text).
 * `userParam`/`workspaceParam` 은 MemberRole 서브쿼리 바인딩용 파라미터 fragment.
 * `workspaceMatch` 는 cross-workspace 쿼리(me-activity 등)에서 채널의 workspaceId
 * 와 MemberRole.workspaceId 를 묶는 추가 조건(없으면 Prisma.empty).
 */
export function roleOverridePrincipalMatchSql(refs: {
  principalId: Prisma.Sql;
  roleLiteral: Prisma.Sql;
  userParam: Prisma.Sql;
  workspaceMatch?: Prisma.Sql;
}): Prisma.Sql {
  const { principalId, roleLiteral, userParam } = refs;
  const workspaceMatch = refs.workspaceMatch ?? Prisma.empty;
  return Prisma.sql`(
    ${principalId} = ${roleLiteral}
    OR ${principalId} IN (
      SELECT mr."roleId"::text
        FROM "MemberRole" mr
       WHERE mr."userId" = ${userParam}
       ${workspaceMatch}
    )
  )`;
}

/**
 * S47 fix-forward (BLOCKER-4): 미읽음 멘션 판정 단일 출처. everyone/here/channel 은
 * `@>` JSONB containment 로 GIN 인덱스를 활용하고, 직접 멘션은 users 배열 containment
 * 로 본다. `msgRef` 는 메시지 별칭 fragment(예 `Prisma.sql\`msg\``), `userParam` 은
 * userId 파라미터 fragment(예 `Prisma.sql\`${userId}::text\``).
 */
export function mentionMatchSql(msgRef: Prisma.Sql, userParam: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(
    ${msgRef}.mentions @> jsonb_build_object('users', jsonb_build_array(${userParam}))
    OR ${msgRef}.mentions @> '{"everyone":true}'::jsonb
    OR ${msgRef}.mentions @> '{"here":true}'::jsonb
    OR ${msgRef}.mentions @> '{"channel":true}'::jsonb
  )`;
}
