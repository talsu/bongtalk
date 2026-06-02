import type { MessageDto } from '@qufox/shared-types';

/**
 * S37 (FR-MSG-17): "메시지 복사"의 정본 텍스트를 결정한다.
 *
 * 우선순위: contentPlain → content → ''.
 *
 * `contentPlain` 은 표준 MessageDto 계약의 일부다 — 서버 toDto 가 마크다운
 * `content` 와 별개로 사람이 읽는 평문을 직렬화하고, WS message.created/updated
 * 페이로드도 동일하게 싣는다(S37). 그래서 평문 정본을 우선 복사하고, 구 API
 * 빌드 응답 등으로 null 이면 마크다운 `content` 로 폴백한다(첨부만 있는 빈 본문
 * 은 ''). `??` 단락이라 contentPlain 이 빈 문자열('')이면 그 값을 그대로 쓴다.
 */
export function resolveCopyPlainText(msg: MessageDto): string {
  return msg.contentPlain ?? msg.content ?? '';
}
