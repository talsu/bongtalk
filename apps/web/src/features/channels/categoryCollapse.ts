/**
 * S43 (FR-CH-14): 카테고리 접기/펼치기 상태(localStorage 영속).
 *
 * PRD 정본 키 형식 그대로: `{workspaceId}:category:{categoryId}:collapsed`.
 * 값은 `'1'`(접힘)만 저장하고, 키가 없으면 펼침으로 간주한다 — "새 기기에서는
 * 기본 펼침"(PRD). 이 모듈은 web-only·마이그레이션 0 이며 순수하게 키 계산 +
 * 안전한 localStorage 접근만 담당해 단위 검증을 결정적으로 한다.
 *
 * localStorage 접근이 막힌 환경(프라이빗 모드·SSR·테스트 jsdom 예외 등)에서도
 * 던지지 않도록 read/write 를 try/catch 로 감싼다 — 실패 시 펼침 fallback.
 */

const COLLAPSED_VALUE = '1';

/** PRD 정본 키 형식. */
export function collapsedKey(workspaceId: string, categoryId: string): string {
  return `${workspaceId}:category:${categoryId}:collapsed`;
}

/** 접힘 여부 조회. 키 없음/접근 실패 → false(펼침). */
export function isCategoryCollapsed(workspaceId: string, categoryId: string): boolean {
  try {
    return window.localStorage.getItem(collapsedKey(workspaceId, categoryId)) === COLLAPSED_VALUE;
  } catch {
    return false;
  }
}

/**
 * 접힘 상태 저장. collapsed=true 면 `'1'` 저장, false 면 키 제거(펼침 = 키 없음
 * 으로 정규화해 저장소 누적을 막는다). 접근 실패는 조용히 무시.
 */
export function setCategoryCollapsed(
  workspaceId: string,
  categoryId: string,
  collapsed: boolean,
): void {
  try {
    const key = collapsedKey(workspaceId, categoryId);
    if (collapsed) {
      window.localStorage.setItem(key, COLLAPSED_VALUE);
    } else {
      window.localStorage.removeItem(key);
    }
  } catch {
    // 저장 실패는 UX 비차단 — 다음 세션엔 기본 펼침으로 복원될 뿐이다.
  }
}
