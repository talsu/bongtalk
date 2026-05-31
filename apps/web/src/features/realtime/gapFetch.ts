import type { ListMessagesResponse, MessageDto } from '@qufox/shared-types';
import { GAP_FETCH_MAX_PAGES, PENDING_EVENTS_MAX } from '@qufox/shared-types';

/**
 * S10 (FR-RT-07): gap-fetch 코어 — 순수/주입형 로직.
 *
 * 재연결 후 seq hole 또는 replay.truncated 가 감지된 채널에 대해
 * `GET .../messages?after={cursor}&limit=50` 를 hasMore 가 거짓이 될 때까지
 * 재귀 호출해 누락 메시지를 모두 끌어옵니다. 최대 GAP_FETCH_MAX_PAGES(10)
 * 페이지에서 멈추며, 초과 시 truncated=true 로 보고합니다.
 *
 * 결과 메시지는 id 기준 dedup + 오름차순 정렬(머지 안정성)로 반환합니다.
 * 실제 React Query 캐시 병합/`channel:synced` 처리/pendingEvents flush 는
 * 호출자(useChannelSync)가 수행합니다.
 *
 * fetchPage 는 주입형이라 단위 테스트가 네트워크 없이 페이징 분기를
 * 검증합니다.
 */

/** 한 페이지를 가져오는 함수. `after` 커서 기준 더 새로운 메시지를 반환. */
export type FetchPageFn = (after: string) => Promise<ListMessagesResponse>;

export type GapFetchResult = {
  /** 머지된(id dedup + 오름차순) 메시지. */
  messages: MessageDto[];
  /** 가져온 페이지 수. */
  pages: number;
  /** GAP_FETCH_MAX_PAGES 초과로 더 남은 메시지가 있을 수 있음. */
  truncated: boolean;
  /** 가장 오래된(첫) 머지 메시지 id — channel:synced 보고용. */
  oldestFetchedId: string | null;
};

/**
 * `after` 커서부터 hasMore 가 끝날 때까지 재귀 페이징합니다.
 *
 * 페이지 응답 items 는 서버 계약상 createdAt DESC 입니다. 다음 페이지 커서는
 * 가장 오래된(=마지막) 항목의 nextCursor 가 아니라, "더 새로운" 방향(after)을
 * 이어가기 위해 가장 새 항목의 prevCursor 를 씁니다 — 호출자가 cursorOf 로
 * 다음 after 를 결정합니다.
 */
export async function runGapFetch(
  fetchPage: FetchPageFn,
  initialAfter: string,
  nextAfterCursor: (page: ListMessagesResponse) => string | null,
): Promise<GapFetchResult> {
  const byId = new Map<string, MessageDto>();
  let after: string | null = initialAfter;
  let pages = 0;
  let truncated = false;

  while (after !== null) {
    if (pages >= GAP_FETCH_MAX_PAGES) {
      truncated = true;
      break;
    }
    const page: ListMessagesResponse = await fetchPage(after);
    pages += 1;
    for (const m of page.items) byId.set(m.id, m);
    if (!page.pageInfo.hasMore) break;
    const next = nextAfterCursor(page);
    if (next === null || next === after) break; // 진전 없음 → 무한 루프 방지
    after = next;
  }

  // id 오름차순(머지 안정성). id 는 시간순 단조(uuid v7/cuid2 정렬 가정)는
  // 아니지만, 캐시 머지 시 Set dedup 후 createdAt 기준 재정렬은 캐시 머지
  // 단계가 책임지므로 여기서는 결정적(id) 정렬만 보장합니다.
  const messages = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  return {
    messages,
    pages,
    truncated,
    oldestFetchedId: messages.length > 0 ? messages[0].id : null,
  };
}

/**
 * 재연결 시 GAP_FETCHING 진입 채널의 수신 WS 이벤트를 적재하는 버퍼.
 * PENDING_EVENTS_MAX(200) 초과 시 더 적재하지 않고 overflow 플래그를 세웁니다
 * (truncated 동기화로 이어짐). flush 는 적재 순서를 보존합니다.
 */
export class PendingEventBuffer {
  private readonly buf: Array<{ event: string; payload: unknown }> = [];
  private overflowed = false;

  /** 적재. 상한 초과면 false(드롭) 반환 + overflow 플래그 세팅. */
  push(event: string, payload: unknown): boolean {
    if (this.buf.length >= PENDING_EVENTS_MAX) {
      this.overflowed = true;
      return false;
    }
    this.buf.push({ event, payload });
    return true;
  }

  get size(): number {
    return this.buf.length;
  }

  get didOverflow(): boolean {
    return this.overflowed;
  }

  /** 적재된 이벤트를 순서대로 비우고 반환. */
  drain(): Array<{ event: string; payload: unknown }> {
    const out = this.buf.splice(0, this.buf.length);
    this.overflowed = false;
    return out;
  }
}

/**
 * 지수 백오프 계산기 — gap-fetch 재시도용. 3회 연속 실패면 caller 가
 * SYNC_FAILED 로 전이합니다. base=500ms, factor=2, cap=8000ms.
 */
export class Backoff {
  private attempt = 0;
  constructor(
    private readonly base = 500,
    private readonly factor = 2,
    private readonly cap = 8000,
    private readonly maxAttempts = 3,
  ) {}

  /** 다음 시도까지의 지연(ms). 매 호출마다 attempt 를 1 증가. */
  nextDelay(): number {
    const delay = Math.min(this.cap, this.base * Math.pow(this.factor, this.attempt));
    this.attempt += 1;
    return delay;
  }

  /** 한도(기본 3회) 도달 여부. */
  get exhausted(): boolean {
    return this.attempt >= this.maxAttempts;
  }

  get attempts(): number {
    return this.attempt;
  }

  reset(): void {
    this.attempt = 0;
  }
}
