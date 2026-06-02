/**
 * S18 (FR-RC05) / S42 (FR-PK02) — : 이모지 자동완성 필터 (순수 함수).
 *
 * 유니코드(글리프+shortcode 이름) + 워크스페이스 커스텀 이모지(이름 + 별칭)를
 * 혼합해 shortcode 부분 일치로 필터하고, 최근 사용 → prefix → 알파벳 순으로 정렬,
 * 최대 10개(S42 — 종전 12)를 반환합니다. 커스텀 이모지는 `task-037` 엔드포인트
 * (useCustomEmojis)를 재사용하며 별도 검색 API 는 신설하지 않습니다.
 *
 * S42 (FR-PK02): 별칭 후보는 `{ kind:'custom', name: alias, insertName: 원본 name }`
 * 로 주입됩니다. `name` 은 매칭/표시용 별칭, `insertName` 은 선택 시 삽입할 카노니컬
 * `:name:` 입니다. insertName 이 없으면(=별칭 아님) name 자체가 카노니컬입니다.
 */
export type EmojiCandidate =
  | { kind: 'unicode'; name: string; glyph: string }
  | { kind: 'custom'; name: string; url: string; insertName?: string };

type FilterInput = {
  unicode: EmojiCandidate[];
  custom: EmojiCandidate[];
  /** 최근 사용 shortcode 이름(앞일수록 최근). */
  recent: string[];
  query: string;
  limit: number;
};

export function filterEmojis({
  unicode,
  custom,
  recent,
  query,
  limit,
}: FilterInput): EmojiCandidate[] {
  const q = query.toLowerCase();
  const recentRank = new Map<string, number>();
  recent.forEach((name, i) => recentRank.set(name.toLowerCase(), i));

  // custom 을 앞에 둬서 동점일 때 워크스페이스 팩이 먼저 노출되도록 한다.
  const all = [...custom, ...unicode];
  const scored = all
    .map((emoji, index) => {
      const name = emoji.name.toLowerCase();
      const isPrefix = name.startsWith(q);
      const isMatch = q.length === 0 || name.includes(q);
      return { emoji, index, name, isPrefix, isMatch };
    })
    .filter((s) => s.isMatch);

  scored.sort((a, b) => {
    const ra = recentRank.has(a.name) ? recentRank.get(a.name)! : Infinity;
    const rb = recentRank.has(b.name) ? recentRank.get(b.name)! : Infinity;
    if (ra !== rb) return ra - rb;
    if (a.isPrefix !== b.isPrefix) return a.isPrefix ? -1 : 1;
    if (a.name !== b.name) return a.name.localeCompare(b.name);
    return a.index - b.index; // 안정 정렬(custom 우선 유지)
  });

  return scored.slice(0, limit).map((s) => s.emoji);
}
