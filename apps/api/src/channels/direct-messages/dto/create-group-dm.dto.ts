import { ArrayNotEmpty, IsArray, IsOptional, IsUUID } from 'class-validator';

/**
 * S16 (HIGH fix-forward): POST /me/dms/groups body 검증.
 *
 * 형식(배열·UUID)만 검증한다. 구성원 상한(본인 포함 ≤20 → 초과 시 422
 * DM_GROUP_CAP_EXCEEDED)은 **서비스 레이어**에 둔다 — DTO 에 @ArrayMaxSize 를
 * 걸면 ValidationPipe 가 400 을 던져 422 계약이 깨지므로 의도적으로 생략한다.
 */
export class CreateGroupDmDto {
  /** 본인을 제외한 멤버 userId 목록(각 UUID v4). 최소 1개(서비스가 ≥2 강제). */
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  memberIds!: string[];

  /** 워크스페이스 스코프 그룹 DM 일 때만 지정. 생략 시 전역(친구 게이트). */
  @IsOptional()
  @IsUUID('4')
  workspaceId?: string;
}
