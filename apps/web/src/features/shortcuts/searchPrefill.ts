/**
 * S31 (FR-S12 + reviewer NIT5/DM): Ctrl/Cmd+F 로 열 검색 패널의 초기 쿼리를
 * 결정하는 순수 함수. 컴포넌트/훅 없이 단위 테스트할 수 있도록 분리합니다.
 *
 * 규칙:
 *  - in:#<채널> 프리필은 *텍스트성 채널*(TEXT / ANNOUNCEMENT)에서만 적합합니다.
 *    DM / 그룹 DM 은 #채널 이름이 없으므로(in:#<userId> 는 부적합) 빈 쿼리로
 *    빈 패널을 엽니다.
 *  - 채널을 못 찾으면(목록 미로딩 등) 빈 쿼리로 둡니다.
 */

/** 검색 in: 프리필이 가능한 채널 타입(텍스트성). */
const PREFILLABLE_TYPES: ReadonlySet<string> = new Set(['TEXT', 'ANNOUNCEMENT']);

export function searchPrefillQuery(channelName: string, channelType: string | undefined): string {
  if (channelType !== undefined && PREFILLABLE_TYPES.has(channelType)) {
    return `in:#${channelName} `;
  }
  return '';
}
