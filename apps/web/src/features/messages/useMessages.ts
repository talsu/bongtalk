import { useCallback, useEffect, useRef } from 'react';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import type {
  ListEditHistoryResponse,
  ListMessagesQuery,
  ListMessagesResponse,
  ListPinsResponse,
  PinCountResponse,
  MessageDto,
} from '@qufox/shared-types';
import {
  deleteMessage,
  getEditHistory,
  getPinCount,
  listMessages,
  listPins,
  pinMessage,
  sendMessage,
  unpinMessage,
  updateMessage,
} from './api';
import { qk } from '../../lib/query-keys';
import { useAuth } from '../auth/AuthProvider';
import { useNotifications } from '../../stores/notification-store';
import { friendlyError } from '../../lib/error-messages';
import {
  confirmOptimistic,
  markOptimisticFailed,
  markOptimisticPending,
  nonceFromOptimisticId,
  optimisticIdFor,
  type OptimisticMessage,
} from './sendState';
import { applyTimeoutFailure } from './timeoutFlip';
import { messageSendTimeoutMs } from './sendTimeout';
import { lruKey, useChannelLruStore } from '../realtime/channelLru';
import { useReadState } from '../realtime/readStateStore';

const keys = {
  // Route through the single qk registry so the realtime dispatcher and
  // this hook build the IDENTICAL tuple — reviewer flagged drift risk.
  // DM callers pass null for wsId; the qk helper accepts the sentinel
  // 'global' to keep tuples distinct across DM channels.
  list: (wsId: string | null, channelId: string) => qk.messages.list(wsId ?? 'global', channelId),
};

/**
 * S05 (FR-MSG-06): 편집 낙관적 잠금 409 처리. 단일 출처 — useUpdateMessage 의
 * onError 와 editConflict.spec 이 **이 동일 함수**를 공유해 테스트 drift 를
 * 막는다(reviewer MED-2). 에러가 MESSAGE_VERSION_CONFLICT 면 서버가 details.current
 * 로 실어보낸 최신 MessageDto 로 캐시 행을 교체(낙관적 편집 롤백 + 최신 본문 반영)
 * 하고 안내 토스트를 push 한 뒤 `true` 를 반환한다. 그 외 코드면 아무것도 안 하고
 * `false` 를 반환해 호출부가 일반 에러 처리로 이어가게 한다.
 */
export function applyEditConflict(
  qc: QueryClient,
  wsId: string | null,
  channelId: string,
  err: unknown,
): boolean {
  const code = (err as { errorCode?: string } | undefined)?.errorCode;
  if (code !== 'MESSAGE_VERSION_CONFLICT') return false;
  const current = (err as { details?: { current?: MessageDto } } | undefined)?.details?.current;
  if (current) {
    qc.setQueryData<InfiniteData<ListMessagesResponse>>(keys.list(wsId, channelId), (old) => {
      if (!old) return old;
      return {
        ...old,
        pages: old.pages.map((p) => ({
          ...p,
          items: p.items.map((m) => (m.id === current.id ? current : m)),
        })),
      };
    });
  }
  useNotifications.getState().push({
    variant: 'danger',
    title: '메시지 수정 실패',
    body: '다른 곳에서 수정되었습니다. 최신 내용을 확인하세요.',
    ttlMs: 5000,
  });
  return true;
}

/**
 * task-041 B-2 (review M2): pure body builder for the send-failure
 * toast. Takes the bubbled API error (which may carry `.status` /
 * `.errorCode` from `bubbleError` in `lib/api.ts`) and returns the
 * Korean title + body. Branches:
 *   - undefined status → network down ("네트워크 연결을 확인하세요.")
 *   - status without errorCode → "서버 응답 NNN. ..."
 *   - status with errorCode    → "서버 응답 NNN (CODE). ..."
 *
 * Exported for testing — the mutation-driven spec asserts each branch
 * without rendering React, fixing review M2's "grep-only" coverage.
 */
export function buildSendFailureToastBody(err: unknown): { title: string; body: string } {
  const status = (err as { status?: number } | undefined)?.status;
  const code = (err as { errorCode?: string } | undefined)?.errorCode;
  // 071-M3 F6 (FR-CH-23): 슬로우모드 429 는 generic 대신 잔여시간을 안내한다
  // (retryAfterMs 는 F1 의 bubbleError additive 전달 — 종전엔 소실됐다).
  if (code === 'CHANNEL_SLOWMODE_ACTIVE') {
    const ms = (err as { retryAfterMs?: number } | undefined)?.retryAfterMs ?? 0;
    const sec = Math.ceil(ms / 1000);
    return {
      title: '슬로우모드 진행 중',
      body: sec > 0 ? `${sec}초 후 다시 보낼 수 있어요.` : '잠시 후 다시 보낼 수 있어요.',
    };
  }
  return {
    title: '메시지 전송 실패',
    body:
      status === undefined
        ? '네트워크 연결을 확인하세요.'
        : `서버 응답 ${status}${code ? ` (${code})` : ''}. 잠시 후 다시 시도하세요.`,
  };
}

/**
 * S94 (067 / FR-MSG-14): 버블된 API 에러가 서버의 대규모 범위 멘션 확인 요구
 * (BULK_MENTION_CONFIRM_REQUIRED · 409)인지 판정한다. 이 경우 send onError 는 일반
 * 실패 토스트 대신 확인 dialog 위임 콜백을 호출한다(서버 안전망). 순수 함수라
 * onError 분기 회귀를 React 렌더 없이 단위 검증할 수 있다.
 */
export function isBulkMentionConfirmRequired(err: unknown): boolean {
  return (err as { errorCode?: string } | undefined)?.errorCode === 'BULK_MENTION_CONFIRM_REQUIRED';
}

/**
 * S09 (FR-RT-22): 메시지 목록 페이지의 fetch 쿼리 인자 결정 — 단일 출처.
 *
 * LRU 로 evict 됐던 채널을 재진입하는 **초기 로드**(pageParam undefined)면,
 * 보유한 lastReadMessageId 를 중심으로 `around` 재로드해 사용자가 마지막으로
 * 읽던 지점으로 복원합니다. lastRead 가 없거나 evict 이력이 없으면 around
 * 없이 최신 로드로 폴백합니다(과설계 방지). older-page fetch(pageParam 존재)는
 * 항상 `before` 커서를 씁니다.
 *
 * S30 fix-forward (BLOCKER 기능 M2): 검색 결과 점프(`?msg=<id>`)가 있으면 초기
 * 로드에서 그 메시지를 `around` anchor 로 삼습니다. lastRead 기반 복원보다
 * **우선**합니다(사용자가 명시적으로 그 메시지로 점프하길 원했으므로).
 * jumpMessageId 가 있으면 LRU around 소비 분기는 건너뜁니다.
 *
 * S97 (FR-RT-22 하드닝): 이 함수는 LRU pendingAround 플래그를 **peek**(소비
 * 없음)합니다. 종전엔 queryFn 안에서 1회성 consumeAround 로 소진했는데, 그러면
 *   - HIGH-2: network 실패로 queryFn 이 retry 될 때 첫 시도에서 이미 소진돼
 *     around 가 영구 상실됐고,
 *   - MED-1: lastReadMessageId 가 아직 미공급(channel:joined race)이면 플래그만
 *     소진되고 around 는 못 써 영영 복원 기회를 잃었습니다.
 * 이제 peek + lastRead 존재 시에만 around 를 쓰고, 플래그 clear 는 **첫 페이지
 * fetch 성공 후**(useMessageHistory queryFn 의 await 성공 직후)에 1회만 합니다.
 * 따라서 retry 중에는 같은 around 가 재계산되고(HIGH-2), lastRead 미공급이면
 * before 폴백하되 플래그가 남아 lastRead 도착 후 다음 fetch 에서 around 적용
 * 기회를 유지합니다(MED-1). 순수 조회라 queryFn 당 여러 번 호출돼도 안전합니다.
 */
export function resolveListFetchArgs(
  wsId: string | null,
  channelId: string,
  pageParam: string | undefined,
  jumpMessageId?: string | null,
): Partial<ListMessagesQuery> {
  if (pageParam === undefined) {
    // M2: 검색 점프 anchor 가 lastRead 복원보다 우선. (jump 가 있으면 LRU
    // around 플래그는 건드리지 않고 그대로 둔다 — 점프가 곧 around 로드이므로.)
    if (jumpMessageId) return { limit: 50, around: jumpMessageId };
    const wantsAround = useChannelLruStore.getState().peekAround(lruKey(wsId, channelId));
    if (wantsAround) {
      const around = useReadState.getState().getLastRead(channelId);
      // MED-1: lastRead 가 아직 null(미공급/race)이면 around 를 쓰지 않고 before
      // 폴백한다. 플래그는 peek 라 소진되지 않으므로, lastRead 도착 후 다음
      // fetch(refetch/재진입)에서 around 가 적용된다.
      if (around) return { limit: 50, around };
    }
  }
  return { limit: 50, before: pageParam ?? undefined };
}

/**
 * S97 (FR-RT-22 하드닝): 첫 페이지 fetch 가 **성공한 직후** LRU around 플래그를
 * clear 할지 결정하고 수행하는 순수 부수효과 헬퍼. queryFn 의 await 성공 분기에서
 * 호출합니다. 다음 조건이 모두 참일 때만 clear 합니다:
 *   - pageParam === undefined (초기 로드 — older-page fetch 는 around 와 무관),
 *   - jumpMessageId 부재 (jump around 는 LRU pendingAround 유래가 아님),
 *   - 이번 호출에 around 가 실제 적용됨(appliedArgs.around !== undefined).
 * 성공 후에만 호출되므로 retry(network 실패)에는 도달하지 않아 around 가 보존되고
 * (HIGH-2), lastRead 미공급으로 before 폴백한 경우엔 args.around 가 없어 clear 되지
 * 않습니다(MED-1 — 다음 기회 유지). 훅과 단위 테스트가 공유하는 단일 출처입니다.
 */
export function clearAroundFlagOnSuccess(
  wsId: string | null,
  channelId: string,
  pageParam: string | undefined,
  jumpMessageId: string | null | undefined,
  appliedArgs: Partial<ListMessagesQuery>,
): void {
  if (pageParam === undefined && !jumpMessageId && appliedArgs.around !== undefined) {
    useChannelLruStore.getState().clearAround(lruKey(wsId, channelId));
  }
}

export function useMessageHistory(
  wsId: string | null,
  channelId: string,
  // S30 fix-forward (M2): 검색 결과 점프 anchor. 있으면 초기 로드의 around
  // 로 사용(lastRead 복원보다 우선). 호출자가 소비 후 제거하므로 1회성.
  jumpMessageId?: string | null,
) {
  return useInfiniteQuery({
    queryKey: keys.list(wsId, channelId),
    queryFn: async ({ pageParam }) => {
      const param = pageParam as string | undefined;
      const args = resolveListFetchArgs(wsId, channelId, param, jumpMessageId);
      const res = await listMessages(wsId, channelId, args);
      // S97 (FR-RT-22 하드닝): fetch 가 **성공한 직후에만** LRU around 플래그를
      // clear 한다(retry 는 throw 로 여기 도달 전 빠져나가 around 보존 — HIGH-2).
      clearAroundFlagOnSuccess(wsId, channelId, param, jumpMessageId, args);
      return res;
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: ListMessagesResponse) =>
      last.pageInfo.hasMore ? (last.pageInfo.nextCursor ?? undefined) : undefined,
    // DM mode passes wsId=null intentionally (routes to /me/dms/…); the
    // enabled gate must only require channelId so the history still
    // loads. The previous `!!wsId && !!channelId` left DMs stuck on
    // the empty-state placeholder.
    enabled: !!channelId,
  });
}

export function useSendMessage(
  wsId: string | null,
  channelId: string,
  // S94 (067 / FR-MSG-14): 서버가 BULK_MENTION_CONFIRM_REQUIRED(409)를 던지면 일반
  // 실패 토스트 대신 이 콜백으로 컴포저에 위임한다 — 컴포저가 확인 dialog 를 띄우고
  // 확인 시 bulkMentionConfirmed=true 로 재전송한다(서버 안전망). 미지정이면 일반
  // 실패 처리로 폴백한다(콜백 없는 기존 호출부 호환).
  //
  // S94 fix-forward (067 · MED-1): 위임 시 원래 전송의 `clientNonce` 를 함께 넘긴다.
  // 컴포저가 확인 후 send(…, true, clientNonce) 로 **같은 nonce** 재전송하면, onMutate 가
  // 기존 낙관행을 markOptimisticPending 으로 되살려(중복 행 미생성) failed 버블 잔류를
  // 없앤다. 종전엔 재전송이 새 nonce 로 새 낙관행을 만들어 원래 failed 행이 영구 잔류했다.
  onBulkMentionConfirmRequired?: (info: {
    content: string;
    attachmentIds?: string[];
    mention?: string;
    clientNonce: string;
  }) => void,
) {
  const qc = useQueryClient();
  const { user } = useAuth();

  // S09 (FR-RT-05): in-flight 전송별 타임아웃 타이머 + AbortController.
  // optimisticId(=`tmp-<nonce>`) 로 키잉해 onSuccess/onError(settle) 시
  // 해당 타이머를 clear 하고 controller 를 폐기합니다. 재시도는 동일
  // optimisticId 로 다시 mutate 되므로 이전 엔트리를 덮어씁니다.
  const pendingRef = useRef<
    Map<string, { timer: ReturnType<typeof setTimeout>; controller: AbortController }>
  >(new Map());

  const clearPending = useCallback((optimisticId: string) => {
    const entry = pendingRef.current.get(optimisticId);
    if (entry) {
      clearTimeout(entry.timer);
      pendingRef.current.delete(optimisticId);
    }
  }, []);

  // 언마운트 시 남은 타이머 정리(메모리 누수/유령 flip 방지).
  useEffect(() => {
    const pending = pendingRef.current;
    return () => {
      for (const { timer } of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const mutation = useMutation({
    // S03 (FR-MSG-04): `clientNonce` is the SINGLE identifier. The optimistic
    // row id is `optimisticIdFor(clientNonce)`, the POST body `nonce` and the
    // `Idempotency-Key` header all derive from it — no separate tempId.
    mutationFn: async (args: {
      content: string;
      clientNonce: string;
      attachmentIds?: string[];
      // S94 (067 / FR-MSG-14): 대규모 범위 멘션 확인 토큰. 클라 선제 confirm 을
      // 거쳤거나 서버 409(BULK_MENTION_CONFIRM_REQUIRED) 후 재전송 시 true 로 보낸다.
      bulkMentionConfirmed?: boolean;
    }) => {
      const optimisticId = optimisticIdFor(args.clientNonce);
      // S09 (FR-RT-05): 전송 시작과 동시에 타임아웃 타이머 + AbortController 를
      // 건다. 타임아웃 경과해도 201 미수신이면 hung fetch 를 abort 하고 해당
      // 낙관 행을 'failed' 로 flip 한다(applyTimeoutFailure 가 confirmed/failed
      // 이면 no-op → onError/onSuccess 와의 이중 flip 을 막음). 같은
      // optimisticId 로 in-flight 가 남아있으면(재시도) 이전 타이머를 먼저 정리.
      clearPending(optimisticId);
      const controller = new AbortController();
      const timer = setTimeout(() => {
        // 타이머가 발화하면: 캐시 행이 여전히 pending 일 때만 failed 로 flip.
        qc.setQueryData<InfiniteData<ListMessagesResponse>>(keys.list(wsId, channelId), (old) =>
          applyTimeoutFailure(old, optimisticId),
        );
        // hung fetch 를 끊는다. AbortError 가 onError 로 흐를 수 있으나
        // 행은 이미 failed 이고 applyTimeoutFailure/markOptimisticFailed 는
        // idempotent 라 이중 flip 이 발생하지 않는다. 전송 실패 토스트는
        // 1회 노출된다.
        controller.abort();
      }, messageSendTimeoutMs());
      pendingRef.current.set(optimisticId, { timer, controller });
      return sendMessage(
        wsId,
        channelId,
        {
          content: args.content,
          ...(args.attachmentIds && args.attachmentIds.length > 0
            ? { attachmentIds: args.attachmentIds }
            : {}),
          // S94 (067 / FR-MSG-14): 확인 토큰. true 일 때만 동봉(미동봉=undefined 보수).
          ...(args.bulkMentionConfirmed ? { bulkMentionConfirmed: true } : {}),
        },
        // clientNonce → POST body nonce + Idempotency-Key header.
        args.clientNonce,
        controller.signal,
      );
    },
    onMutate: async ({ content, clientNonce }) => {
      await qc.cancelQueries({ queryKey: keys.list(wsId, channelId) });
      const optimisticId = optimisticIdFor(clientNonce);
      // Optimistic prepend. authorId resolves to the real viewer id so
      // MessageList's continuation rule (same author + <5min gap) matches the
      // previous row without waiting for the server echo. `sendState:'pending'`
      // drives the clock/spinner affordance; on failure we flip it to 'failed'
      // and KEEP the row (FR-MSG-05) so a "다시 시도" button can re-fire the
      // same clientNonce.
      const optimistic: OptimisticMessage = {
        id: optimisticId,
        channelId,
        authorId: user?.id ?? 'optimistic',
        content,
        // S02: optimistic 메시지는 아직 서버 파싱 전이라 contentAst 가 없음.
        // MessageItem 이 contentAst 부재 시 contentRaw/content 정규식 렌더로
        // 폴백하므로 pending 상태에서도 본문이 보입니다. 서버 에코로 교체될
        // 때 contentAst 가 채워집니다.
        contentRaw: content,
        contentAst: null,
        // S37 (FR-MSG-17): optimistic 메시지는 아직 서버 파싱 전이라 평문 정본도
        // 원문(content)을 그대로 쓴다. 서버 에코로 교체될 때 파서 평문으로 갱신된다.
        contentPlain: content,
        // S04: optimistic 메시지는 항상 일반 메시지(DEFAULT).
        type: 'DEFAULT',
        mentions: {
          users: [],
          channels: [],
          everyone: false,
          here: false,
          channel: false,
          roles: [],
        },
        edited: false,
        deleted: false,
        createdAt: new Date().toISOString(),
        editedAt: null,
        reactions: [],
        parentMessageId: null,
        thread: null,
        attachments: [],
        // task-044-iter2: optimistic 메시지는 항상 미고정 상태입니다.
        pinnedAt: null,
        pinnedBy: null,
        // S05 (FR-MSG-06): optimistic 메시지는 아직 서버 row 가 없어 version 0.
        // 서버 에코(message:created)로 실제 version 으로 교체됩니다.
        version: 0,
        // S35 (FR-TH-06): optimistic 메시지는 broadcast 행이 아니다.
        isBroadcast: false,
        parentExcerpt: null,
        // S38 (FR-TH-13): optimistic 메시지는 루트라도 아직 미잠금.
        threadLocked: false,
        // S60 (FR-RC07): optimistic 메시지는 아직 unfurl 전이라 embed 없음. 서버가
        // 비동기 unfurl 후 message:embed_updated 로 채운다.
        embeds: [],
        sendState: 'pending',
      };
      qc.setQueryData<InfiniteData<ListMessagesResponse>>(keys.list(wsId, channelId), (old) => {
        if (!old) return old;
        const [first, ...rest] = old.pages;
        if (!first) return old;
        // If this is a RETRY, the failed row already exists — flip it back to
        // pending instead of duplicating it.
        const exists = first.items.some((m) => m.id === optimisticId);
        if (exists) return markOptimisticPending(old, optimisticId) ?? old;
        return { ...old, pages: [{ ...first, items: [optimistic, ...first.items] }, ...rest] };
      });
      return { optimisticId };
    },
    onError: (err, vars, ctx) => {
      const optimisticId = ctx?.optimisticId ?? optimisticIdFor(vars.clientNonce);
      // S94 fix-forward (067 / FR-MSG-14 · MED-1): 서버 대규모 범위 멘션 확인 요구(409)면
      // 일반 실패 토스트 대신 컴포저에 위임한다(확인 dialog → bulkMentionConfirmed=true
      // 재전송). 이 경우 낙관행을 **failed 로 표시하지 않고**(early return·markOptimisticFailed
      // 미적용) pending 상태로 유지한다. 컴포저가 확인 후 **같은 clientNonce** 로 재전송하면
      // onMutate 가 이 행을 markOptimisticPending 으로 되살려(중복 행 미생성) 그대로 이어간다.
      // 종전엔 여기서 failed 로 표시한 뒤 재전송이 새 nonce 로 새 행을 만들어, 원래 failed
      // 버블이 딜리버된 메시지 옆에 영구 잔류했다(고아 "다시 시도" 버블). 서버 중복은 없다
      // (409 가 INSERT 전이라 idempotencyKey 미소비). 콜백이 없으면(기존 호출부) 아래 일반
      // 실패 처리로 내려가 failed 표시 + 토스트를 수행한다.
      if (isBulkMentionConfirmRequired(err) && onBulkMentionConfirmRequired) {
        const mention = (err as { details?: { mention?: string } } | undefined)?.details?.mention;
        onBulkMentionConfirmRequired({
          content: vars.content,
          attachmentIds: vars.attachmentIds,
          mention,
          // MED-1: 원래 nonce 를 위임해 재전송이 같은 낙관행을 재사용하게 한다.
          clientNonce: vars.clientNonce,
        });
        return;
      }
      // FR-MSG-05: do NOT roll the row out — mark it failed so the bubble keeps
      // showing the content + a "다시 시도" button (same clientNonce on retry).
      qc.setQueryData<InfiniteData<ListMessagesResponse>>(keys.list(wsId, channelId), (old) =>
        markOptimisticFailed(old, optimisticId),
      );
      // task-040 R3 + task-041 B-2 (review M2 follow): surface send failure via
      // a danger toast. Body builder extracted so the mutation-driven test can
      // assert each error-shape branch without spinning up React.
      useNotifications.getState().push({
        variant: 'danger',
        ...buildSendFailureToastBody(err),
        ttlMs: 5000,
      });
    },
    onSuccess: (result, { clientNonce }) => {
      // Replace the optimistic row with the confirmed server row. The
      // message:created WS echo may race this — confirmOptimistic is
      // idempotent (no-op if the row is already gone, FR-RT-24 dedupe).
      const optimisticId = optimisticIdFor(clientNonce);
      qc.setQueryData<InfiniteData<ListMessagesResponse>>(keys.list(wsId, channelId), (old) =>
        confirmOptimistic(old, optimisticId, result.message),
      );
    },
    onSettled: (_result, _err, { clientNonce }) => {
      // S09 (FR-RT-05): 성공/실패 무관하게 settle 되면 타임아웃 타이머를
      // 즉시 clear 한다 — 정상 201 후 타이머가 늦게 발화해 confirmed 행을
      // 건드리는 일이 없도록(applyTimeoutFailure 가 no-op 이긴 하나 타이머
      // 누수를 막는 게 정석).
      clearPending(optimisticIdFor(clientNonce));
    },
  });

  const send = useCallback(
    (
      content: string,
      attachmentIds?: string[],
      bulkMentionConfirmed?: boolean,
      // S94 fix-forward (067 · MED-1): 대규모 멘션 확인 dialog 후 재전송 경로가 **원래**
      // clientNonce 를 넘기면(같은 Idempotency-Key·같은 낙관행) onMutate 가 기존 행을
      // 되살려 failed 버블 잔류를 막는다. 미지정(일반 첫 전송)이면 새 UUID 를 발급한다.
      reuseClientNonce?: string,
    ) => {
      // FR-MSG-04: ONE UUID v4 — used as the optimistic id seed, POST body
      // nonce, and Idempotency-Key header. (재전송이면 원래 nonce 를 재사용한다.)
      const clientNonce = reuseClientNonce ?? crypto.randomUUID();
      mutation.mutate({ content, clientNonce, attachmentIds, bulkMentionConfirmed });
    },
    [mutation],
  );

  /**
   * FR-MSG-05: retry a failed send. The caller passes the optimistic row's id
   * (which encodes the original clientNonce); the retry re-fires with the SAME
   * nonce so the server dedupes against the original Idempotency-Key.
   */
  const retry = useCallback(
    (failedId: string, content: string, attachmentIds?: string[]) => {
      // S03 review NIT: recover the original clientNonce from the optimistic
      // row id (`tmp-<nonce>`). A failed row id is ALWAYS optimistic, so a
      // null here means the caller passed a confirmed/server id by mistake —
      // feeding that raw into `nonce: z.string().uuid()` would 400 with a
      // generic toast. Bail loudly in dev instead of silently misfiring.
      const clientNonce = nonceFromOptimisticId(failedId);
      if (clientNonce === null) {
        if (import.meta.env.DEV) {
          throw new Error(`retry() expected an optimistic id, got "${failedId}"`);
        }
        return;
      }
      mutation.mutate({ content, clientNonce, attachmentIds });
    },
    [mutation],
  );

  return { send, retry, mutation };
}

/**
 * S05 (FR-MSG-06): 메시지 편집 mutation. 편집창 오픈 시 스냅샷한
 * `expectedVersion` 을 PATCH 에 항상 동봉합니다(낙관적 잠금).
 *
 * 409(MESSAGE_VERSION_CONFLICT) 수신 시: 서버가 details.current 로 실어보낸
 * 최신 MessageDto 로 캐시 행을 즉시 교체(낙관적 편집 롤백 + 최신 본문 반영)
 * 하고 "다른 곳에서 수정되었습니다" 안내 토스트를 띄웁니다. MessageItem 의
 * onEditSave 가 reject 를 받으므로 편집창은 닫히지 않고 유지됩니다.
 */
export function useUpdateMessage(
  wsId: string | null,
  channelId: string,
  // S94 fix-forward (067 / FR-MSG-14 · HIGH-1): 편집(PATCH)으로 새로 추가한 대규모 범위
  // 멘션이 임계값을 넘어 서버가 BULK_MENTION_CONFIRM_REQUIRED(409)를 던지면, send 와 동일하게
  // 이 콜백으로 위임한다 — 호출부가 확인 dialog 를 띄우고 확인 시 bulkMentionConfirmed=true
  // 로 같은 편집을 재시도한다. 미지정이면 일반 실패 토스트로 폴백한다(기존 호출부 호환).
  onBulkMentionConfirmRequired?: (info: {
    msgId: string;
    content: string;
    expectedVersion: number;
    mention?: string;
  }) => void,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      msgId,
      content,
      expectedVersion,
      bulkMentionConfirmed,
    }: {
      msgId: string;
      content: string;
      expectedVersion: number;
      // S94 fix-forward (067 · HIGH-1): 편집 확인 토큰. 409 후 확인 dialog 를 거쳐 true 로
      // 재편집 시 동봉한다. true 일 때만 보낸다(미동봉=undefined 보수).
      bulkMentionConfirmed?: boolean;
    }) =>
      updateMessage(wsId, channelId, msgId, {
        content,
        expectedVersion,
        ...(bulkMentionConfirmed ? { bulkMentionConfirmed: true } : {}),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.list(wsId, channelId) }),
    onError: (err, vars) => {
      // S94 fix-forward (067 / FR-MSG-14 · HIGH-1): 편집으로 새로 추가한 대규모 범위 멘션
      // 확인 요구(409)면 일반 실패 토스트 대신 위임한다(확인 dialog → bulkMentionConfirmed=true
      // 재편집). 콜백이 없으면 아래 일반 처리로 내려간다. 편집 conflict(version)와는 별개
      // 코드이므로 applyEditConflict 보다 먼저 가른다.
      if (isBulkMentionConfirmRequired(err) && onBulkMentionConfirmRequired) {
        const mention = (err as { details?: { mention?: string } } | undefined)?.details?.mention;
        onBulkMentionConfirmRequired({
          msgId: vars.msgId,
          content: vars.content,
          expectedVersion: vars.expectedVersion,
          mention,
        });
        return;
      }
      // S05 (FR-MSG-06): 낙관적 잠금 충돌이면 공유 함수가 캐시 롤백 + 토스트를
      // 처리하고 true 를 반환한다 — 그 외 에러만 아래 일반 처리로 내려간다.
      if (applyEditConflict(qc, wsId, channelId, err)) return;
      // task-047 iter6 (P-individual): friendlyError → toast.
      const f = friendlyError(err);
      useNotifications.getState().push({
        variant: 'danger',
        title: '메시지 수정 실패',
        body: f.message,
        ttlMs: 5000,
      });
    },
  });
}

export function useDeleteMessage(wsId: string | null, channelId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (msgId: string) => deleteMessage(wsId, channelId, msgId),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.list(wsId, channelId) }),
    // task-047 iter6 (P-individual): friendlyError → toast.
    onError: (err) => {
      const f = friendlyError(err);
      useNotifications.getState().push({
        variant: 'danger',
        title: '메시지 삭제 실패',
        body: f.message,
        ttlMs: 5000,
      });
    },
  });
}

/**
 * task-045 iter1: pin / unpin mutations. DM 채널 (wsId=null) 은
 * BE 가 pinned 미지원 — 호출자가 wsId 존재 시에만 dropdown 노출
 * 책임집니다. 성공 시 invalidate 하여 메시지 list 의 pinnedAt 갱신.
 * (WS dispatcher 의 MESSAGE_PIN_TOGGLED 가 broadcast 단에서도 별도
 * 갱신 — 두 path 가 idempotent 하게 동일한 cache 도달.)
 */
export function usePinMessage(wsId: string | null, channelId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (msgId: string) => {
      if (!wsId) {
        return Promise.reject(new Error('DM 채널은 메시지 고정을 지원하지 않습니다'));
      }
      return pinMessage(wsId, channelId, msgId);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.list(wsId, channelId) }),
    onError: (err) => {
      const f = friendlyError(err);
      useNotifications.getState().push({
        variant: 'danger',
        title: '메시지 고정 실패',
        body: f.message,
        ttlMs: 5000,
      });
    },
  });
}

export function useUnpinMessage(wsId: string | null, channelId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (msgId: string) => {
      if (!wsId) {
        return Promise.reject(new Error('DM 채널은 메시지 고정을 지원하지 않습니다'));
      }
      return unpinMessage(wsId, channelId, msgId);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.list(wsId, channelId) }),
    onError: (err) => {
      const f = friendlyError(err);
      useNotifications.getState().push({
        variant: 'danger',
        title: '메시지 고정 해제 실패',
        body: f.message,
        ttlMs: 5000,
      });
    },
  });
}

/**
 * S50 (D10 · FR-PS-03): 채널 핀 목록 조회 훅. 핀 패널이 열렸을 때만(`enabled`)
 * fetch 합니다. wsId 가 null(DM)이면 핀 미지원이므로 비활성입니다. 정렬은 서버가
 * pinnedAt DESC 로 보장하며, channel:pin_added/removed 이벤트가 캐시를 invalidate
 * 해 패널이 실시간 갱신됩니다.
 */
export function usePins(wsId: string | null, channelId: string, enabled: boolean) {
  return useQuery<ListPinsResponse>({
    queryKey: qk.messages.pins(wsId ?? 'global', channelId),
    queryFn: () => {
      if (!wsId) {
        return Promise.reject(new Error('DM 채널은 메시지 고정을 지원하지 않습니다'));
      }
      return listPins(wsId, channelId);
    },
    enabled: enabled && !!wsId && !!channelId,
    staleTime: 10_000,
  });
}

/**
 * S50 (D10 · FR-PS-03): 채널 헤더 핀 카운트 배지 훅. 경량(본문 없이 수만) 조회로,
 * 헤더가 항상 마운트되므로 enabled 기본 true. channel:pin_added/removed 가
 * invalidate 한다. wsId 가 null(DM)이면 비활성(핀 미지원).
 */
export function usePinCount(wsId: string | null, channelId: string) {
  return useQuery<PinCountResponse>({
    queryKey: qk.messages.pinCount(wsId ?? 'global', channelId),
    queryFn: () => {
      if (!wsId) {
        return Promise.reject(new Error('DM 채널은 메시지 고정을 지원하지 않습니다'));
      }
      return getPinCount(wsId, channelId);
    },
    enabled: !!wsId && !!channelId,
    staleTime: 10_000,
  });
}

/**
 * S37 (FR-MSG-08): 메시지 편집 이력 조회 훅. 팝오버가 열렸을 때만(`enabled`)
 * fetch 합니다 — 매 메시지마다 선행 요청하지 않습니다. wsId 가 null(DM)이면
 * 서버에 워크스페이스 스코프 history 엔드포인트가 없으므로 비활성입니다.
 * 권한 없음(403 MESSAGE_NOT_AUTHOR)은 react-query 의 error 상태로 흐르며,
 * 팝오버 컴포넌트가 친절 메시지로 처리합니다(재시도 불필요 — 권한은 안 바뀜).
 */
export function useEditHistory(
  wsId: string | null,
  channelId: string,
  msgId: string,
  enabled: boolean,
) {
  return useQuery<ListEditHistoryResponse>({
    // S37 보안 fix-forward: 키에 wsId/channelId 를 포함해 스코프를 명시한다
    // (DM 센티넬 'global'). 범위 격리 + 디스패처 무효화 키와 정합.
    queryKey: qk.messages.editHistory(wsId ?? 'global', channelId, msgId),
    queryFn: () => {
      if (!wsId) {
        return Promise.reject(new Error('DM 채널은 편집 이력을 지원하지 않습니다'));
      }
      return getEditHistory(wsId, channelId, msgId);
    },
    enabled: enabled && !!wsId && !!channelId && !!msgId,
    // 권한 거부(403)는 재시도해도 동일하므로 자동 재시도를 끈다.
    retry: false,
    // S37 보안 fix-forward: 역할 강등(예: ADMIN→MEMBER) 후 stale 이력이 노출되는
    // 창을 최소화한다 — staleTime 30s → 5s 이하 + gcTime:0(팝오버 닫힘 시 즉시
    // 파기). 재편집 시 stale 스냅샷은 dispatcher 의 message.updated 무효화가
    // 추가로 막는다.
    staleTime: 5_000,
    gcTime: 0,
  });
}

/**
 * S37 fix-forward (BLOCKER-1): permalink(`?msg=`) 점프 전용 one-shot around 로드.
 *
 * 문제: 메인 list 쿼리는 `messages.list(wsId, channelId)` 키만 쓰므로,
 * jumpMessageId 가 around arg 로 바뀌어도 채널이 이미 캐시돼 있으면 queryFn 이
 * 재실행되지 않는다(키 불변 → 캐시 hit). 그 결과 window-밖에 존재하는 메시지로
 * 점프해도 around-load 가 발화되지 않아, "목록에 없음"을 곧 not-found 로 오판해
 * 거짓 토스트가 떴다(BLOCKER-1).
 *
 * 해결: 점프 대상 단위로 키잉한 별도 around 쿼리를 둔다. 메인 list 캐시와
 * 분리(`jumpAround` 키)되어 캐시 오염이 없고, gcTime:0 으로 소비 후 즉시 파기된다.
 * 이 쿼리의 settled 상태 + 결과(대상 id 포함 여부 / 404)가 toast 판정과 cache
 * seed(스크롤 가능하도록 메인 list 를 around 결과로 교체)의 단일 출처가 된다.
 *
 * DM(wsId=null)도 around 를 지원하므로 동작한다(키는 'global' 센티넬).
 * jumpMessageId 가 null 이면 비활성(`enabled:false`).
 */
export function useJumpAround(
  wsId: string | null,
  channelId: string,
  jumpMessageId?: string | null,
) {
  return useQuery<ListMessagesResponse>({
    queryKey: qk.messages.jumpAround(wsId ?? 'global', channelId, jumpMessageId ?? ''),
    queryFn: () => listMessages(wsId, channelId, { limit: 50, around: jumpMessageId ?? undefined }),
    enabled: !!channelId && !!jumpMessageId,
    // 404(MESSAGE_NOT_FOUND anchor)는 재시도해도 동일 — 자동 재시도 끈다.
    retry: false,
    gcTime: 0,
    staleTime: 0,
  });
}

/** Trigger fetchNextPage when the user scrolls near the top of a message list. */
export function useScrollFetch(
  rootRef: React.RefObject<HTMLElement>,
  onReachTop: () => void,
): void {
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onScroll = () => {
      if (el.scrollTop < 100) onReachTop();
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, [rootRef, onReachTop]);
}
