import type { SlashCommandItem } from '@qufox/shared-types';

/**
 * S79 (D15 / FR-SC-02) — / 슬래시 커맨드 퍼지 필터 (순수 함수).
 *
 * 슬래시 커맨드 목록(빌트인 상수 + 워크스페이스 커스텀 병합)을 받아 query 로 필터·
 * 랭크한다. name 매칭을 우선(가중치 2)하고 description 매칭을 보조(가중치 1)로 둔다.
 * 동점은 (1) 빌트인 우선 → (2) name prefix 매치 우선 → (3) name 알파벳 순으로 결정한다.
 *
 * 서버 검색 엔드포인트는 신설하지 않는다 — GET 목록(useSlashCommands)을 클라이언트에서
 * 필터만 한다(@멘션/#채널 자동완성과 동일 전략).
 */
type ScoredCommand = {
  command: SlashCommandItem;
  /** name+2 / desc+1 합산 점수. 매칭 없으면 0(제외). */
  score: number;
  /** name prefix 매치(동점 결정용). */
  isNamePrefix: boolean;
};

function scoreCommand(command: SlashCommandItem, q: string): ScoredCommand {
  const name = command.name.toLowerCase();
  const desc = command.description.toLowerCase();
  if (q.length === 0) {
    // query 가 없으면(`/` 직후) 전체를 동점으로 노출(prefix=true 로 안정 정렬).
    return { command, score: 1, isNamePrefix: true };
  }
  const isNamePrefix = name.startsWith(q);
  const nameHit = name.includes(q);
  const descHit = desc.includes(q);
  let score = 0;
  if (nameHit) score += 2;
  if (descHit) score += 1;
  return { command, score, isNamePrefix };
}

export function filterSlashCommands(
  commands: SlashCommandItem[],
  query: string,
  limit: number,
): SlashCommandItem[] {
  const q = query.toLowerCase();
  const scored = commands.map((command) => scoreCommand(command, q)).filter((s) => s.score > 0);

  scored.sort((a, b) => {
    // 1) 점수 내림차순(name 매칭이 desc 매칭을 이긴다).
    if (a.score !== b.score) return b.score - a.score;
    // 2) 빌트인 우선.
    if (a.command.isBuiltin !== b.command.isBuiltin) return a.command.isBuiltin ? -1 : 1;
    // 3) name prefix 매치 우선.
    if (a.isNamePrefix !== b.isNamePrefix) return a.isNamePrefix ? -1 : 1;
    // 4) name 알파벳 순.
    return a.command.name.localeCompare(b.command.name);
  });

  return scored.slice(0, limit).map((s) => s.command);
}
