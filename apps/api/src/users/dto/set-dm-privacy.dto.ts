import { IsIn } from 'class-validator';

/**
 * S19 (FR-DM-12 / HIGH fix-forward): PATCH /users/me/dm-privacy body 검증.
 *
 * 이전 컨트롤러는 `@Body() body: { allowDmFrom?: string }` plain 타입이라 글로벌
 * ValidationPipe(whitelist / forbidNonWhitelisted)가 적용되지 않았다 — 추가 필드가
 * silently 통과하고 잘못된 값은 서비스 분기에서야 거부됐다. DTO 클래스로 바꿔
 * ValidationPipe 가 형식을 강제한다(추가 필드 → 400, 허용 외 값 → 400).
 *
 * 허용 값은 EVERYONE | WORKSPACE_MEMBER 뿐이다 — FRIENDS_ONLY 는 Phase2 carryover
 * 라 @IsIn 화이트리스트에 없으므로 자동 거부(400)된다. shared-types DmPrivacySchema
 * (z.enum) 및 Prisma DmPrivacy enum 과 1:1 정합이다.
 */
export class SetDmPrivacyDto {
  @IsIn(['EVERYONE', 'WORKSPACE_MEMBER'])
  allowDmFrom!: 'EVERYONE' | 'WORKSPACE_MEMBER';
}
