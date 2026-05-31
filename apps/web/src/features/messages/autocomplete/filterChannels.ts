/**
 * S18 (FR-RC04) — # 채널 자동완성 필터 (순수 함수).
 *
 * 현재 워크스페이스 채널 목록(기존 useChannelList query)을 받아 prefix 필터
 * 합니다. 서버 검색은 신설하지 않습니다. topic 은 `__sub` 미리보기에 씁니다.
 * prefix 매치를 우선하되 동점은 알파벳으로 결정합니다.
 */
export type RankableChannel = {
  id: string;
  name: string;
  topic: string | null;
};

type FilterInput = {
  channels: RankableChannel[];
  query: string;
  limit: number;
};

export function filterChannels({ channels, query, limit }: FilterInput): RankableChannel[] {
  const q = query.toLowerCase();
  const matched = channels
    .map((channel) => {
      const name = channel.name.toLowerCase();
      const isPrefix = name.startsWith(q);
      const isMatch = q.length === 0 || isPrefix || name.includes(q);
      return { channel, isMatch, isPrefix };
    })
    .filter((s) => s.isMatch);

  matched.sort((a, b) => {
    if (a.isPrefix !== b.isPrefix) return a.isPrefix ? -1 : 1;
    return a.channel.name.localeCompare(b.channel.name);
  });

  return matched.slice(0, limit).map((s) => s.channel);
}
