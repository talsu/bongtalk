/**
 * S82a (FR-KS-01) — 퀵스위처 퍼지 랭킹 (순수 함수).
 *
 * `rankMembers.ts`(@멘션 자동완성)의 정렬 철학을 채널·멤버·DM 통합 항목으로
 * 확장한 것입니다. 외부 퍼지 라이브러리(Fuse.js 등)는 번들 비용 때문에 도입하지
 * 않고, 동일한 prefix > recent > unread/online > substring 위치 > 알파벳 키를
 * 클라이언트에서 직접 계산합니다.
 *
 * 정렬 키(우선순위 높은 순):
 *   1. 접두(prefix) 매치 우대 (검색어로 이름이 시작)
 *   2. 최근 방문 가중치 (recentRank 가 작을수록 최근 → 앞)
 *   3. 읽지 않음/온라인 가중치 (boost 가 큰 항목 우선)
 *   4. substring 매치 위치 (앞쪽에서 매치될수록 앞)
 *   5. 알파벳(동점 결정 — 라벨 localeCompare)
 *
 * `@` 접두 = 멤버/DM 만, `#` 접두 = 채널만 으로 좁히는 필터는 호출부에서 항목을
 * 추리기 전에 수행하고(섹션 단위), 이 함수는 이미 추려진 동종 항목 배열에 대해
 * 검색어 매칭 + 정렬만 합니다(쿼리에서 접두 문자는 제거한 뒤 전달).
 */

export type QsKind = 'channel' | 'member' | 'dm';

export interface RankableQsItem {
  /** 안정 식별자 — 항목 종류별로 충돌하지 않도록 호출부에서 prefix 를 붙여 둡니다. */
  id: string;
  kind: QsKind;
  /** 매칭/표시에 쓰는 사람이 읽는 라벨(채널명·표시명·상대 username). */
  label: string;
  /**
   * 추가 매칭 키(예: 멤버 username 핸들). label 과 함께 prefix/substring 매칭에
   * 포함됩니다. 없으면 label 만 사용합니다.
   */
  keywords?: string[];
  /**
   * 읽지 않음/온라인 등 "상위 노출" 가중치. 큰 값일수록 동점에서 앞에 옵니다.
   * (읽지 않은 채널/온라인 멤버를 살짝 끌어올리는 용도 — 0 이 기본.)
   */
  boost?: number;
}

interface RankInput {
  items: RankableQsItem[];
  /** 접두 문자(@/#)를 제거한 순수 검색어. 빈 문자열이면 전체를 boost/recent 순으로. */
  query: string;
  /** 최근 방문 항목 id 목록(앞일수록 최근). */
  recent: string[];
  /** 항목 종류별 결과 상한(전체 합산이 아니라 호출부가 종류별로 부른다고 가정). */
  limit: number;
}

interface Scored {
  item: RankableQsItem;
  isPrefix: boolean;
  /** substring 최초 매치 위치(없으면 Infinity, prefix 면 0). */
  matchPos: number;
}

function matchKeys(item: RankableQsItem): string[] {
  return [item.label, ...(item.keywords ?? [])].map((s) => s.toLowerCase());
}

export function rankQuickSwitcher({ items, query, recent, limit }: RankInput): RankableQsItem[] {
  const q = query.trim().toLowerCase();
  const recentRank = new Map<string, number>();
  recent.forEach((id, i) => recentRank.set(id, i));

  const scored: Scored[] = [];
  for (const item of items) {
    const keys = matchKeys(item);
    if (q.length === 0) {
      scored.push({ item, isPrefix: false, matchPos: Infinity });
      continue;
    }
    let isPrefix = false;
    let matchPos = Infinity;
    for (const key of keys) {
      if (key.startsWith(q)) {
        isPrefix = true;
        matchPos = 0;
        break;
      }
      const idx = key.indexOf(q);
      if (idx >= 0 && idx < matchPos) matchPos = idx;
    }
    if (!isPrefix && matchPos === Infinity) continue; // 미매치 제외
    scored.push({ item, isPrefix, matchPos });
  }

  scored.sort((a, b) => {
    if (a.isPrefix !== b.isPrefix) return a.isPrefix ? -1 : 1;
    const ra = recentRank.get(a.item.id) ?? Infinity;
    const rb = recentRank.get(b.item.id) ?? Infinity;
    if (ra !== rb) return ra - rb; // 최근일수록 앞
    const ba = a.item.boost ?? 0;
    const bb = b.item.boost ?? 0;
    if (ba !== bb) return bb - ba; // boost 큰 항목 우선
    if (a.matchPos !== b.matchPos) return a.matchPos - b.matchPos; // 앞쪽 매치 우선
    return a.item.label.localeCompare(b.item.label);
  });

  return scored.slice(0, limit).map((s) => s.item);
}
