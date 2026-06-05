import {
  ExecuteSlashCommandResponseSchema,
  SlashCommandListResponseSchema,
  type ExecuteSlashCommandResponse,
  type SlashCommandItem,
} from '@qufox/shared-types';
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

/**
 * S80 (D15 / FR-SC-04·05·06) — 슬래시 커맨드 실행 API 클라이언트.
 *
 * POST /workspaces/:workspaceId/channels/:channelId/slash-commands/execute → IN_CHANNEL
 * (messageId) 또는 EPHEMERAL(content/error) 응답. idempotencyKey 로 멱등 재시도를 안전히 한다.
 * 응답은 discriminated union Zod 로 파싱해 계약 위반을 런타임에서도 잡는다.
 */
export async function executeSlashCommand(args: {
  workspaceId: string;
  channelId: string;
  command: string;
  text: string;
  idempotencyKey: string;
}): Promise<ExecuteSlashCommandResponse> {
  const raw = await apiRequest(
    `/workspaces/${args.workspaceId}/channels/${args.channelId}/slash-commands/execute`,
    {
      method: 'POST',
      body: {
        command: args.command,
        text: args.text,
        idempotencyKey: args.idempotencyKey,
      },
    },
  );
  return ExecuteSlashCommandResponseSchema.parse(raw);
}
