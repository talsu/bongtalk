/**
 * S23 (FR-RS-06/07): NEW MESSAGES 구분선 + Jump-to-Unread pill 의 순수 로직.
 *
 * DOM/가상화/React 비의존 — MessageList 가 가상화 행 삽입·스크롤 판정에 쓰고,
 * newMessages.spec 이 동일 함수를 검증한다(테스트 drift 방지 단일 출처).
 *
 * ── firstUnread 판정(FR-RS-06) ──
 * 채널 진입 시점의 읽음 상태를 두 소스로 받아 "lastRead 직후 첫 미읽 메시지"
 * 의 ASC 배열 index 를 계산한다:
 *   1. `lastReadMessageId` — 멀티세션 read-state / channel:joined seam. 배열에
 *      있으면 그 직후 index 가 firstUnread (가장 정확, S21 (createdAt,id) 커서가
 *      서버에서 이미 정렬됐으므로 배열 위치가 곧 튜플 순서).
 *   2. `unreadCount` — unread-summary 의 채널별 미읽 카운트. lastReadMessageId 가
 *      배열에 없거나(윈도우 밖·store 미보유) null 이면 "끝에서 unreadCount 번째"
 *      를 firstUnread 로 역산한다(끝 정렬 = 최신이 미읽이라는 불변식).
 *
 * 미읽이 없으면(둘 다 표시 위치를 못 만들면) null → 구분선 미표시(FR-RS-06).
 */
export interface FirstUnreadInput {
  /** ASC(오래된→최신) 렌더 순서의 메시지 id 배열. */
  messageIds: ReadonlyArray<string>;
  /** 마지막으로 읽은 메시지 id(없으면 null). */
  lastReadMessageId: string | null;
  /** 채널 미읽 메시지 수(unread-summary). 음수 불가. */
  unreadCount: number;
}

export function computeFirstUnreadIndex(input: FirstUnreadInput): number | null {
  const { messageIds, lastReadMessageId, unreadCount } = input;
  if (messageIds.length === 0) return null;

  // 1순위: lastReadMessageId 가 배열에 있으면 그 직후가 firstUnread.
  if (lastReadMessageId !== null) {
    const idx = messageIds.indexOf(lastReadMessageId);
    if (idx >= 0) {
      const next = idx + 1;
      // 커서가 마지막 메시지면 직후가 없다 → 표시 위치 없음(미읽 0 취급).
      return next < messageIds.length ? next : null;
    }
    // 배열에 없으면 unreadCount 역산으로 폴백(아래로 진행).
  }

  // 2순위: unreadCount 로 끝에서 역산. unreadCount 가 0 이면 미읽 없음.
  if (unreadCount <= 0) return null;
  const firstUnread = messageIds.length - unreadCount;
  // unreadCount 가 전체보다 크면(클램프) index 0 부터 전부 미읽.
  return Math.max(0, firstUnread);
}

/**
 * ── Jump-to-Unread pill 표시 판정(FR-RS-07) ──
 * IntersectionObserver 대신 가상화 인덱스 비교를 쓴다(가상화 리스트는 구분선이
 * 마운트되지 않은 채 윈도우 밖일 수 있어 IO 가 신뢰 불가). 현재 첫 렌더 가상
 * 행 인덱스(`firstRenderedIndex`)가 구분선 정렬 인덱스(`dividerIndex`)보다 크면
 * 구분선이 위로 벗어난 것 → pill 표시. 같거나 작으면(구분선이 윈도우 안/위) 숨김.
 *
 * dividerIndex 는 "구분선이 차지하는 정렬 인덱스" = computeFirstUnreadIndex 결과
 * (구분선은 firstUnread 메시지 바로 위에 끼므로 firstUnread 메시지가 보이면
 * 구분선도 보인다 — firstRenderedIndex <= dividerIndex 이면 보이는 것으로 본다).
 */
export interface JumpPillInput {
  /** 현재 가상 윈도우의 첫(최상단) 행 인덱스. 미정이면 null. */
  firstRenderedIndex: number | null;
  /** 구분선 정렬 인덱스(= firstUnread index). 미읽 없으면 null. */
  dividerIndex: number | null;
}

export function shouldShowJumpPill(input: JumpPillInput): boolean {
  const { firstRenderedIndex, dividerIndex } = input;
  if (dividerIndex === null) return false;
  if (firstRenderedIndex === null) return false;
  return firstRenderedIndex > dividerIndex;
}

/**
 * S23 MAJOR fix (jump pill overscan 오판): 가상화는 뷰포트 *위로* overscan(8행)
 * 만큼 행을 더 마운트하므로, `getVirtualItems()[0].index` 를 그대로 "보이는
 * 최상단"으로 쓰면 구분선이 화면 밖(위)인데도 마운트돼 있다는 이유로 pill 이
 * 숨는다. 실제로 보이는 최상단 = 첫 `start + size > scrollTop` 인 행(행 하단이
 * 뷰포트 상단을 넘어선 첫 행)이다. 그 행의 가상 인덱스를 반환해 jump 판정에
 * 쓴다. 후보가 없으면(전부 위로 벗어남) 마지막 행 인덱스로 폴백, 빈 목록이면 null.
 *
 * 순수 함수 — virtualItem 의 {index, start, size} 만 받아 DOM/가상화 비의존.
 */
export interface VisibleRow {
  index: number;
  start: number;
  size: number;
}

export function firstVisibleIndex(
  rows: ReadonlyArray<VisibleRow>,
  scrollTop: number,
): number | null {
  if (rows.length === 0) return null;
  for (const r of rows) {
    // 행 하단(start + size)이 뷰포트 상단(scrollTop)을 넘어선 첫 행 = 보이는 최상단.
    if (r.start + r.size > scrollTop) return r.index;
  }
  // 모든 행이 뷰포트 위로 벗어남(드문 경계) → 마지막 행으로 폴백.
  return rows[rows.length - 1].index;
}

/**
 * ── 구분선 별도 행 삽입 플랜(FR-RS-06 가상화) ──
 * NEW MESSAGES 구분선을 가상화 리스트의 **독립 행**으로 끼우기 위한 좌표 매핑.
 * virtualizer.count = messageCount + (구분선 있으면 1). 가상 인덱스가 구분선
 * 자리면 메시지가 아니고(null), 구분선보다 뒤면 한 칸 밀린 메시지 인덱스로
 * 변환한다. day-divider 와 달리(메시지 행 안 prepend) NEW MESSAGES 는 별도
 * estimateSize 행이라 jump 판정(첫 렌더 가상행 vs 구분선 가상행)이 정확하다.
 *
 * `dividerMessageIndex` 는 firstUnread 메시지의 ASC 인덱스(computeFirstUnreadIndex
 * 결과)다. 구분선은 그 메시지 **바로 위**에 끼므로 구분선의 가상 인덱스는
 * dividerMessageIndex 와 같다(그 위치의 메시지가 한 칸 뒤로 밀린다).
 */
export interface RowPlan {
  /** virtualizer.count 에 넣을 총 행 수(메시지 + 구분선). */
  count: number;
  /** 메시지 ASC 개수. */
  messageCount: number;
  /** 구분선이 차지하는 가상 인덱스(없으면 null). */
  dividerVirtualIndex: number | null;
}

export function buildRowPlan(input: {
  messageCount: number;
  dividerIndex: number | null;
}): RowPlan {
  const { messageCount, dividerIndex } = input;
  const valid =
    dividerIndex !== null && dividerIndex >= 0 && dividerIndex <= messageCount
      ? dividerIndex
      : null;
  return {
    count: messageCount + (valid !== null ? 1 : 0),
    messageCount,
    dividerVirtualIndex: valid,
  };
}

/**
 * 가상 인덱스 → 메시지 ASC 인덱스. 구분선 행이면 null(메시지 아님).
 * 구분선 가상 인덱스 이후의 행은 한 칸 당겨 실제 메시지 인덱스를 얻는다.
 */
export function messageIndexForVirtualIndex(plan: RowPlan, virtualIndex: number): number | null {
  const { dividerVirtualIndex } = plan;
  if (dividerVirtualIndex === null) return virtualIndex;
  if (virtualIndex === dividerVirtualIndex) return null;
  return virtualIndex < dividerVirtualIndex ? virtualIndex : virtualIndex - 1;
}

/**
 * 메시지 ASC 인덱스 → 가상 인덱스(messageIndexForVirtualIndex 의 역). 구분선
 * 가상 인덱스 이상이면 +1 밀어 메시지 행의 가상 좌표를 얻는다. anchor restore
 * 가 메시지 인덱스로 virtualItem.start 를 찾을 때 좌표 변환에 쓴다.
 */
export function virtualIndexForMessageIndex(plan: RowPlan, messageIndex: number): number {
  const { dividerVirtualIndex } = plan;
  if (dividerVirtualIndex === null) return messageIndex;
  return messageIndex >= dividerVirtualIndex ? messageIndex + 1 : messageIndex;
}

/** 구분선 행의 가상 인덱스(없으면 null). scrollToIndex 대상이자 jump 판정 기준. */
export function virtualIndexForDivider(plan: RowPlan): number | null {
  return plan.dividerVirtualIndex;
}

/**
 * S23 MAJOR fix (cold 캐시 구분선): 채널 open zero-out 이전에 고정하는 구분선
 * 스냅샷의 순수 환산. MessageColumn 이 (a) unread-summary 캐시의 채널 행
 * unreadCount(cold/미캐시면 undefined)와 (b) readStateStore 의 lastReadMessageId
 * 를 받아 진입 시점의 스냅샷으로 굳힌다.
 *
 * 핵심: cold summary(아직 미캐시)면 unreadCount 를 못 읽어 0 으로 폴백하지만,
 * lastReadMessageId(멀티세션 read-state seam)가 남아 있으면 구분선 판정은
 * computeFirstUnreadIndex 의 1순위(lastRead 직후)로 여전히 가능하다. 따라서
 * 스냅샷은 두 신호를 모두 보존한다(둘 다 없으면 미읽 0 → 구분선 미표시).
 */
export interface UnreadSnapshot {
  unreadCount: number;
  lastReadMessageId: string | null;
}

export function captureUnreadSnapshot(input: {
  /** unread-summary 캐시의 채널 행 unreadCount. cold/미캐시면 undefined. */
  cachedUnreadCount: number | undefined;
  /** readStateStore 의 채널 lastReadMessageId(없으면 null). */
  lastReadMessageId: string | null;
}): UnreadSnapshot {
  return {
    unreadCount: input.cachedUnreadCount ?? 0,
    lastReadMessageId: input.lastReadMessageId,
  };
}

/**
 * 마지막 가상행 인덱스(= count-1). 바닥 고정 scrollToIndex 대상. 마지막 행은
 * 항상 메시지(구분선은 firstUnread 메시지 앞 중간)라 count-1 이 곧 최신 메시지의
 * 가상 좌표다. 빈 목록이면 -1.
 */
export function lastRowVirtualIndex(plan: RowPlan): number {
  return plan.count - 1;
}
