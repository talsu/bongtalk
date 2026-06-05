import { TRIGGER_KIND_LABEL, type TriggerKind } from './autocomplete/detectTrigger';

/**
 * S78 (FR-A11Y-01): 컴포저 자동완성 팝업의 스크린리더 공지 문구를 만든다.
 *
 * PRD D15: 모든 자동완성 팝업은 공유 라이브 영역(`qf-a11y-announcer`)에 결과
 * 수 변경을 알린다. 결과가 0건이면 "검색 결과가 없습니다", 그 외에는
 * "<종류 명사> N개" 로 공지한다. 슬래시 커맨드(S79)도 같은 헬퍼를 확장해 쓸
 * 수 있도록 종류 → 명사 매핑만 추가하면 된다.
 *
 * S78 reviewer FF6 (contract): 종류 → 명사 매핑은 detectTrigger.ts 의
 * TRIGGER_KIND_LABEL 단일 출처를 쓴다(Autocomplete 섹션 헤더와 공유). 종전
 * 로컬 상수 AC_SECTION_NOUN 은 Autocomplete.SECTION_LABEL 과 중복이었다.
 *
 * empty-result 분기(rowCount<=0): 자동완성 훅은 rows>0 일 때만 팝업을 여므로
 * (useAutocomplete: open = … && rows.length > 0), 컴포저의 자동 공지 경로로는
 * 이 분기가 닿지 않는다. 다만 호출부가 "트리거는 활성이지만 결과 0건" 상태를
 * 명시적으로 공지하고 싶을 때(MessageComposer 의 trigger-active 감지) 또는
 * 향후 검색 제안처럼 0건도 열어두는 팝업에서 재사용할 수 있도록 분기를
 * 유지한다(FF3 — 죽은 분기 아님).
 */
export function composerAnnouncement(kind: TriggerKind, rowCount: number): string {
  // S79 fix-forward (a11y N-01): 0건 문구를 종류별로 분기한다. 종전 "검색 결과가
  // 없습니다" 는 어떤 트리거(@멤버 / #채널 / :이모지 / /슬래시)에서 결과가 없는지
  // SR 에 전달하지 못했다. "<종류 명사> 검색 결과가 없습니다" 로 맥락을 준다.
  if (rowCount <= 0) return `${TRIGGER_KIND_LABEL[kind]} 검색 결과가 없습니다`;
  return `${TRIGGER_KIND_LABEL[kind]} ${rowCount}개`;
}
