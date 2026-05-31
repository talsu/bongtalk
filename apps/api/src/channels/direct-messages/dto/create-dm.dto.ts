import { IsOptional, IsUUID } from 'class-validator';

/**
 * S16 (HIGH fix-forward): POST /me/dms body 검증. CLAUDE.md "모든 API input:
 * class-validator" 계약에 맞춰 plain interface @Body() 를 DTO 로 교체한다.
 * 형식(UUID)만 검증하고 친구 게이트·중복 처리는 서비스 레이어가 담당한다.
 */
export class CreateDmDto {
  /** 대화 상대 userId (UUID v4). */
  @IsUUID('4')
  userId!: string;

  /**
   * 워크스페이스 스코프 DM 일 때만 지정. 생략 시 전역(친구 게이트) DM.
   * 현재 글로벌 DM 컨트롤러는 항상 null 로 위임하지만, 형식 검증은 유지한다.
   */
  @IsOptional()
  @IsUUID('4')
  workspaceId?: string;
}
