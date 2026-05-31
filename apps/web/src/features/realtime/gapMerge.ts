import type { InfiniteData } from '@tanstack/react-query';
import type { ListMessagesResponse, MessageDto } from '@qufox/shared-types';

/**
 * S10 (FR-RT-07): gap-fetch 결과를 기존 React Query 무한 목록 캐시에 병합 —
 * 순수 로직.
 *
 * 병합 규칙:
 *   - messageId Set 으로 dedup(이미 캐시에 있는 메시지는 신규 본문으로 교체하지
 *     않고 기존 유지 — 낙관적/편집 상태 보존).
 *   - 신규 메시지는 첫 페이지(가장 최신 페이지, index 0)에 추가.
 *   - 최종 정렬은 createdAt DESC, 동률이면 id DESC(서버 목록 계약과 동일).
 *   - reply(parentMessageId != null)는 채널 root 목록에 넣지 않음(스레드 패널
 *     소관) — dispatcher 의 message.created 분기와 동일 불변식.
 *
 * 캐시가 아직 없으면(채널 미진입) old 를 그대로 반환합니다 — gap-fetch 결과는
 * 다음 채널 진입 시 정상 초기 로드로 흡수됩니다.
 */
export function mergeGapMessages(
  old: InfiniteData<ListMessagesResponse> | undefined,
  fetched: MessageDto[],
): InfiniteData<ListMessagesResponse> | undefined {
  if (!old) return old;
  if (fetched.length === 0) return old;
  const [first, ...rest] = old.pages;
  if (!first) return old;

  const seen = new Set<string>();
  for (const p of old.pages) for (const m of p.items) seen.add(m.id);

  const additions = fetched.filter((m) => m.parentMessageId == null && !seen.has(m.id));
  if (additions.length === 0) return old;

  const mergedFirst = [...first.items, ...additions].sort((a, b) => {
    const d = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    return d !== 0 ? d : b.id.localeCompare(a.id);
  });

  return {
    ...old,
    pages: [{ ...first, items: mergedFirst }, ...rest],
  };
}
