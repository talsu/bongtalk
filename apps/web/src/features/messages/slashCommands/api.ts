import { SlashCommandListResponseSchema, type SlashCommandItem } from '@qufox/shared-types';
import { apiRequest } from '../../../lib/api';

/**
 * S79 (D15 / FR-SC-01) — 슬래시 커맨드 목록 API 클라이언트.
 *
 * GET /workspaces/:workspaceId/slash-commands → 빌트인 상수 + 워크스페이스 커스텀
 * 병합 목록. 응답은 shared-types Zod 로 파싱해 계약 위반을 런타임에서도 잡는다.
 */
export async function listSlashCommands(workspaceId: string): Promise<SlashCommandItem[]> {
  const raw = await apiRequest(`/workspaces/${workspaceId}/slash-commands`);
  return SlashCommandListResponseSchema.parse(raw).items;
}
