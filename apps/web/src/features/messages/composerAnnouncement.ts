import type { TriggerKind } from './autocomplete/detectTrigger';

/**
 * S78 (FR-A11Y-01): 컴포저 자동완성 팝업의 스크린리더 공지 문구를 만든다.
 *
 * PRD D15: 모든 자동완성 팝업은 공유 라이브 영역(`qf-a11y-announcer`)에 결과
 * 수 변경을 알린다. 결과가 0건이면 "검색 결과가 없습니다", 그 외에는
 * "<종류 명사> N개" 로 공지한다. 슬래시 커맨드(S79)도 같은 헬퍼를 확장해 쓸
 * 수 있도록 종류 → 명사 매핑만 추가하면 된다.
 */
const AC_SECTION_NOUN: Record<TriggerKind, string> = {
  mention: '멤버',
  channel: '채널',
  emoji: '이모지',
};

export function composerAnnouncement(kind: TriggerKind, rowCount: number): string {
  if (rowCount <= 0) return '검색 결과가 없습니다';
  return `${AC_SECTION_NOUN[kind]} ${rowCount}개`;
}
