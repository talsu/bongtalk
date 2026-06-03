import type { MessageEmbed } from '@prisma/client';
import type { MessageEmbedDto } from '@qufox/shared-types';

/**
 * S60: message.embed.updated 의 서버 내부 outbox eventType(dot 표기). outbox→WS
 * subscriber 가 이 이벤트를 잡아 콜론 wire 이름(message:embed_updated)으로 변환한다
 * (reaction:updated / thread:lock:changed 선례).
 */
export const MESSAGE_EMBED_UPDATED_EVENT = 'message.embed.updated';

/**
 * S60 (FR-RC21): MessageEmbed 행 → 와이어 DTO. imageKey 가 있으면 백엔드 프록시 경로
 * (`/links/embed-image/:id`)를 imageProxyUrl 로 노출한다 — presigned URL 을 직접 노출하지
 * 않는다(매 요청 권한 재검증 + nosniff 는 프록시 컨트롤러가 담당). imageKey 가 없으면 null.
 *
 * read-path 는 suppressedAt IS NULL 만 내려보내지만(서비스 필터), 와이어 forward-compat 을
 * 위해 suppressedAt 도 ISO 문자열로 매핑한다(클라가 hide 판정 가능).
 */
export function toMessageEmbedDto(row: MessageEmbed): MessageEmbedDto {
  return {
    id: row.id,
    url: row.url,
    title: row.title ?? null,
    description: row.description ?? null,
    siteName: row.siteName ?? null,
    imageProxyUrl: row.imageKey ? `/links/embed-image/${row.id}` : null,
    suppressedAt: row.suppressedAt ? row.suppressedAt.toISOString() : null,
  };
}
