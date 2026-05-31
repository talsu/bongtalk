/**
 * S18 (FR-RC03) — @ 멤버 자동완성 순위 (순수 함수).
 *
 * 정렬 키(내림차순 점수):
 *   1. 최근 대화상대 가중치 (recent 배열 인덱스가 작을수록 큼)
 *   2. prefix 매치 품질 (prefix 매치 우대)
 *   3. 온라인 가중치
 *   4. 알파벳(동점 결정)
 *
 * 서버 검색 엔드포인트는 신설하지 않습니다 — 워크스페이스 멤버 목록
 * (`GET /workspaces/:id/members`) 전체를 받아 클라이언트에서 prefix 필터 +
 * 정렬합니다. 멤버 수가 커지면 서버 가중치 정렬로 옮기는 최적화는 DEFER.
 */
export type RankableMember = {
  userId: string;
  username: string;
  /** 표시용 별칭(닉네임). 없으면 username 사용. */
  displayName?: string | null;
};

type RankInput = {
  members: RankableMember[];
  query: string;
  /** 온라인(또는 dnd 포함 connected) userId 집합. */
  online: Set<string>;
  /** 최근 대화상대 userId 목록(앞일수록 최근). */
  recent: string[];
  limit: number;
};

export function rankMembers({
  members,
  query,
  online,
  recent,
  limit,
}: RankInput): RankableMember[] {
  const q = query.toLowerCase();
  const recentRank = new Map<string, number>();
  recent.forEach((id, i) => recentRank.set(id, i));

  const scored = members
    .map((member) => {
      const handle = member.username.toLowerCase();
      const display = (member.displayName ?? '').toLowerCase();
      const isPrefix = handle.startsWith(q) || display.startsWith(q);
      const isMatch = q.length === 0 || isPrefix || handle.includes(q) || display.includes(q);
      return { member, isMatch, isPrefix };
    })
    .filter((s) => s.isMatch);

  scored.sort((a, b) => {
    const ra = recentRank.has(a.member.userId) ? recentRank.get(a.member.userId)! : Infinity;
    const rb = recentRank.has(b.member.userId) ? recentRank.get(b.member.userId)! : Infinity;
    if (ra !== rb) return ra - rb; // 최근일수록 앞
    if (a.isPrefix !== b.isPrefix) return a.isPrefix ? -1 : 1;
    const oa = online.has(a.member.userId) ? 0 : 1;
    const ob = online.has(b.member.userId) ? 0 : 1;
    if (oa !== ob) return oa - ob; // 온라인 우선
    return a.member.username.localeCompare(b.member.username);
  });

  return scored.slice(0, limit).map((s) => s.member);
}
