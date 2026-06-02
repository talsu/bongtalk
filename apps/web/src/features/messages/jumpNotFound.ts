/**
 * S37 (FR-MSG-18): permalink(`?msg=`) 점프 대상이 더 이상 존재하지 않을 때
 * "메시지를 찾을 수 없습니다" 토스트를 띄울지 판정하는 순수 함수.
 *
 * 두 가지 not-found 경로를 다룬다:
 *   1) around anchor 자체가 없음 → 서버가 404(MESSAGE_NOT_FOUND) 로 응답
 *      → react-query 가 isError 상태. (errorCode === 'MESSAGE_NOT_FOUND')
 *   2) anchor 는 살아있지만(주변 컨텍스트는 200) 대상 메시지가 soft-deleted
 *      → 비-모더레이터에겐 목록에서 필터링되어 결과 페이지에 대상 id 가 없음.
 *      이때는 isSuccess 이지만 `found === false`.
 *
 * 아직 fetch 가 끝나지 않은(settled 전) 상태에서는 절대 토스트를 띄우지 않는다
 * (로딩 중 = 미도착이지 not-found 가 아니다). 그래서 `settled` 가 true 일 때만
 * 판정한다.
 */
export function shouldToastJumpNotFound(args: {
  /** `?msg=` 대상 id. null 이면 점프 자체가 없으므로 항상 false. */
  jumpMessageId: string | null;
  /** 로드 완료(에러 or 성공) 여부. false(로딩 중)면 판정 보류. */
  settled: boolean;
  /** 로드된 목록에 대상 msgId 가 존재하는지. */
  found: boolean;
  /** 쿼리가 에러 상태인지. */
  isError: boolean;
}): boolean {
  if (!args.jumpMessageId) return false;
  if (!args.settled) return false;
  // 에러(404 등)이거나, 성공했지만 대상이 목록에 없으면(삭제 필터) not-found.
  return args.isError || !args.found;
}
