import { useCallback, useEffect, useRef, useState } from 'react';
import type { AttachmentLite, UploadSession } from '@qufox/shared-types';
import { completeUpload, requestUploadUrl, uploadToStorage } from './attachmentApi';
import { proxyPath } from './attachmentSrc';
import { uploadErrorToast } from './uploadErrors';

/**
 * 트레이 카드 1개의 라이프사이클 상태.
 *
 * S56: uploading → ready / failed.
 * S57 (FR-AM-24): ready → sending(낙관적 전송) → confirmed(서버 확정) / failed.
 */
export type TrayItemStatus = 'uploading' | 'ready' | 'sending' | 'confirmed' | 'failed';

export type TrayKind = AttachmentLite['kind'];

/**
 * 미전송 첨부 1개. 업로드 중에는 sessionId/storageKey 가 아직 없을 수 있고
 * (단계 1 완료 후 채워짐), READY 가 되면 sessionId 가 확정됩니다. complete 는
 * 전송 시점(doSend)에 한 번에 모읍니다 — 그래서 attachmentId 는 여기 없습니다.
 */
export interface TrayItem {
  /** 클라이언트 로컬 id(React key + 제거/재시도 식별). */
  id: string;
  file: File;
  kind: TrayKind;
  status: TrayItemStatus;
  /** 0~100. uploading 동안만 의미 있음. */
  progress: number;
  /**
   * 미리보기 URL.
   *   uploading/ready/sending: 로컬 objectURL(IMAGE 만 · revoke 대상).
   *   confirmed: 백엔드 프록시 URL(`/attachments/:id/download`) — objectURL 아님.
   * 언마운트/제거/CONFIRMED/FAILED 시 로컬 objectURL 은 revoke 합니다.
   */
  previewUrl: string | null;
  /** 단계 1 완료 후 채워지는 MinIO 업로드 세션 id(complete 에 사용). */
  sessionId: string | null;
  /** 단계 1 의 presign 만료 시각(ISO). complete 직전 잔여<10s 면 재발급. */
  expiresAt: string | null;
  /** 접근성 대체 텍스트(연필 입력). */
  altText: string;
  /** 스포일러(클릭 전 블러) 표식. */
  isSpoiler: boolean;
  /** 이미지 자연 크기(complete 의 width/height 신고용). */
  width?: number;
  height?: number;
  error?: string;
}

function detectKind(mime: string): TrayKind {
  if (mime.startsWith('image/')) return 'IMAGE';
  if (mime.startsWith('video/')) return 'VIDEO';
  return 'FILE';
}

/** READY 상태이면서 complete 가능한 항목만 추린다. */
function isReady(item: TrayItem): boolean {
  return item.status === 'ready' && item.sessionId !== null;
}

// ── FR-AM-24: complete 지수 백오프 ──────────────────────────────────────────
/** 최대 시도 횟수(1차 즉시 + 2회 재시도). */
const COMPLETE_MAX_ATTEMPTS = 3;
/** 시도 간 지연(ms): 1차 즉시(0) · 2차 +10s · 3차 +20s. 총 예산 30s. */
const COMPLETE_BACKOFF_MS = [0, 10_000, 20_000] as const;
// ── FR-AM-24: presign on-demand refresh ─────────────────────────────────────
/** 잔여 만료가 이 값(ms) 미만이면 complete/전송 직전 upload-url 을 재발급한다. */
const EXPIRY_REFRESH_THRESHOLD_MS = 10_000;

// ── FR-AM-28: sessionStorage 세션 복구 ──────────────────────────────────────
const PENDING_SESSIONS_KEY = 'qufox:pending_sessions';

interface PendingSession {
  sessionId: string;
  channelId: string;
}

/** sessionStorage 의 pending 세션 배열을 안전하게 읽는다(파싱 실패 시 []). */
function readPendingSessions(): PendingSession[] {
  if (typeof sessionStorage === 'undefined') return [];
  try {
    const raw = sessionStorage.getItem(PENDING_SESSIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is PendingSession =>
        !!p &&
        typeof p === 'object' &&
        typeof (p as PendingSession).sessionId === 'string' &&
        typeof (p as PendingSession).channelId === 'string',
    );
  } catch {
    return [];
  }
}

function writePendingSessions(list: PendingSession[]): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    if (list.length === 0) sessionStorage.removeItem(PENDING_SESSIONS_KEY);
    else sessionStorage.setItem(PENDING_SESSIONS_KEY, JSON.stringify(list));
  } catch {
    /* quota/private-mode 등 — 복구는 best-effort 라 무시 */
  }
}

function addPendingSession(sessionId: string, channelId: string): void {
  const list = readPendingSessions();
  if (list.some((p) => p.sessionId === sessionId)) return;
  list.push({ sessionId, channelId });
  writePendingSessions(list);
}

function removePendingSessions(sessionIds: Iterable<string>): void {
  const remove = new Set(sessionIds);
  const next = readPendingSessions().filter((p) => !remove.has(p.sessionId));
  writePendingSessions(next);
}

const API_BASE = (import.meta.env?.VITE_API_URL as string | undefined) ?? '/api';

/** CONFIRMED 항목의 미리보기로 쓸 백엔드 프록시 URL(절대 경로). */
function confirmedPreviewUrl(attachmentId: string): string {
  return `${API_BASE}${proxyPath(attachmentId, 'download')}`;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    setTimeout(resolve, ms);
  });

export interface UseAttachmentUploadResult {
  items: TrayItem[];
  /** 업로드 중(uploading) 항목 수 — 전송 버튼 비활성 판정. */
  uploadingCount: number;
  /** 실패 항목 수. */
  failedCount: number;
  /** 전송 진행 중(sending) 항목 수 — 중복 전송 가드. */
  sendingCount: number;
  /** 새 파일들을 트레이에 추가하고 업로드를 시작한다. */
  addFiles: (files: File[]) => void;
  removeItem: (id: string) => void;
  retryItem: (id: string) => void;
  setAltText: (id: string, alt: string) => void;
  toggleSpoiler: (id: string) => void;
  /**
   * 전송 시점: READY 항목들을 sending 으로 낙관 전환 후 complete(지수 백오프)해
   * attachmentIds 를 반환한다. 성공 항목은 confirmed(프록시 URL + 로컬 objectURL
   * revoke), 실패 항목은 failed(objectURL revoke) 로 남긴다. 빈 트레이/READY 없음
   * 이면 [] 반환(첨부 없는 일반 전송). complete 전체 실패 시 토스트 + 빈 배열.
   */
  completeAndCollect: () => Promise<string[]>;
  /**
   * 전송이 끝난(confirmed) 항목을 트레이에서 제거한다(메시지 전송 직후 호출).
   * confirmed previewUrl 은 프록시 URL(objectURL 아님)이라 revoke 불필요하나,
   * 방어적으로 잔존 로컬 objectURL 이 있으면 정리한다.
   */
  clearConfirmed: () => void;
  /** 트레이 전체 비우기(채널 전환 등). objectURL revoke 포함. */
  reset: () => void;
}

interface UploadToast {
  variant: 'danger' | 'warning' | 'info';
  title: string;
  body: string;
}

/**
 * S56 (D11 / FR-AM-02/22) — 첨부 업로드 트레이 상태 + 3단계 업로드 오케스트레이션.
 * S57 (D11 / FR-AM-24/28) — 전송 상태 기계(sending/confirmed) + 지수 백오프 +
 * presign on-demand refresh + sessionStorage 세션 복구.
 *
 * 단계 1·2 는 addFiles 시 항목별로 즉시 실행(병렬), 단계 3(complete)은 전송
 * 시점에 completeAndCollect 가 READY 항목을 한 번에 모아 호출합니다. sortOrder
 * 는 트레이 배열 인덱스(드래그 재정렬은 S59).
 *
 * `notify` 는 토스트 push 콜백(notification-store) — 훅이 store 에 직접 의존하지
 * 않게 주입받아 테스트를 단순화합니다.
 */
export function useAttachmentUpload(
  wsId: string | null,
  channelId: string,
  notify: (t: UploadToast) => void,
): UseAttachmentUploadResult {
  const [items, setItems] = useState<TrayItem[]>([]);
  // objectURL 누수 방지: 마운트된 url 집합을 ref 로 추적해 reset/unmount 시 revoke.
  const objectUrlsRef = useRef<Set<string>>(new Set());
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  // notify 를 ref 로 고정해 completeAndCollect 가 매 렌더 새 함수가 되지 않게 한다.
  const notifyRef = useRef(notify);
  useEffect(() => {
    notifyRef.current = notify;
  }, [notify]);

  const revoke = useCallback((url: string | null): void => {
    if (url && objectUrlsRef.current.has(url)) {
      URL.revokeObjectURL(url);
      objectUrlsRef.current.delete(url);
    }
  }, []);

  const reset = useCallback((): void => {
    for (const url of objectUrlsRef.current) URL.revokeObjectURL(url);
    objectUrlsRef.current.clear();
    setItems([]);
  }, []);

  // 언마운트 시 잔존 objectURL 정리.
  useEffect(() => {
    return () => {
      for (const url of objectUrlsRef.current) URL.revokeObjectURL(url);
      objectUrlsRef.current.clear();
    };
  }, []);

  // FR-AM-28: mount 시 이전 세션(미완료 complete)이 남아 있으면 사용자에게
  // 안내하고 sessionStorage 를 비운다. 해당 TrayItem 은 새 마운트에 더 이상
  // 존재하지 않으므로(메모리 상태는 휘발) 토스트 + 클리어로 충분하다 —
  // 재진입한 사용자는 첨부가 확정되지 않았음을 인지하고 다시 첨부할 수 있다.
  useEffect(() => {
    const leftover = readPendingSessions();
    if (leftover.length === 0) return;
    writePendingSessions([]);
    notifyRef.current({
      variant: 'info',
      title: '이전 업로드가 완료되지 않았습니다',
      body: '이전에 첨부하던 파일의 전송이 끝나지 않았습니다. 필요하면 다시 첨부해 주세요.',
    });
    // mount 1회만(이 repo 는 react-hooks/exhaustive-deps 규칙 미설치 — disable 불필요).
  }, []);

  const patch = useCallback((id: string, next: Partial<TrayItem>): void => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...next } : it)));
  }, []);

  /**
   * S56 fix-forward (MAJOR-2 — CLS): IMAGE previewUrl 을 디코드해 자연 크기를
   * patch 한다. complete 의 width/height 신고 + 메시지 렌더 aspect-ratio 예약을
   * 살린다. 로드 실패(깨진 파일 등)는 무해 — 미신고 폴백으로 흐른다.
   */
  const decodeImageSize = useCallback(
    (id: string, previewUrl: string): void => {
      // jsdom/SSR 등 Image 가 없는 환경에서는 스킵(테스트 안전).
      if (typeof Image === 'undefined') return;
      const img = new Image();
      img.onload = (): void => {
        if (img.naturalWidth > 0 && img.naturalHeight > 0) {
          patch(id, { width: img.naturalWidth, height: img.naturalHeight });
        }
      };
      img.onerror = (): void => {
        /* 폴백: 신고 없이 진행 */
      };
      img.src = previewUrl;
    },
    [patch],
  );

  /**
   * 단계 1(presign 발급)만 수행하고 세션을 반환한다. sessionId/expiresAt 을 patch 하고
   * FR-AM-28 sessionStorage 에 등록한다. wsId 가 null 이면 null 을 반환한다.
   */
  const presign = useCallback(
    async (item: TrayItem): Promise<UploadSession | null> => {
      if (wsId === null) return null;
      const { sessions } = await requestUploadUrl(wsId, channelId, {
        filename: item.file.name,
        size: item.file.size,
        mimeType: item.file.type || 'application/octet-stream',
        count: 1,
      });
      const session = sessions[0];
      if (!session) throw new Error('no upload session returned');
      patch(item.id, { sessionId: session.sessionId, expiresAt: session.expiresAt, progress: 0 });
      // FR-AM-28: presign 확정 시 복구 후보로 등록(complete 성공/제거 시 해제).
      addPendingSession(session.sessionId, channelId);
      return session;
    },
    [wsId, channelId, patch],
  );

  /** 단계 1+2 를 한 항목에 대해 실행. 실패 시 status=failed + 토스트. */
  const runUpload = useCallback(
    async (item: TrayItem): Promise<void> => {
      // DM 채널은 채널 nested 첨부 미지원(S54) — 진입 자체를 막아야 하지만 방어적 가드.
      if (wsId === null) {
        patch(item.id, { status: 'failed', error: 'DM 채널은 첨부를 지원하지 않습니다.' });
        return;
      }
      try {
        const session = await presign(item);
        if (!session) throw new Error('no upload session returned');
        await uploadToStorage(session.upload, item.file, (percent) => {
          patch(item.id, { progress: percent });
        });
        patch(item.id, { status: 'ready', progress: 100 });
      } catch (err) {
        const toast = uploadErrorToast(err, item.file.name);
        patch(item.id, { status: 'failed', error: toast.body });
        notifyRef.current({ variant: 'danger', ...toast });
      }
    },
    [wsId, presign, patch],
  );

  const addFiles = useCallback(
    (files: File[]): void => {
      if (files.length === 0) return;
      const newItems: TrayItem[] = files.map((file) => {
        const kind = detectKind(file.type || '');
        let previewUrl: string | null = null;
        if (kind === 'IMAGE') {
          previewUrl = URL.createObjectURL(file);
          objectUrlsRef.current.add(previewUrl);
        }
        return {
          id: crypto.randomUUID(),
          file,
          kind,
          status: 'uploading' as const,
          progress: 0,
          previewUrl,
          sessionId: null,
          expiresAt: null,
          altText: '',
          isSpoiler: false,
        };
      });
      setItems((prev) => [...prev, ...newItems]);
      for (const it of newItems) {
        void runUpload(it);
        // S56 fix-forward (MAJOR-2 — CLS): IMAGE 는 previewUrl 을 디코드해
        // naturalWidth/Height 를 patch 한다. 종전엔 width/height 가 항상
        // undefined 라 렌더 측 aspect-ratio 예약이 무력했다(complete 의
        // width/height 신고 + 메시지 렌더 비율 예약 둘 다 살린다). 실패해도
        // 무해 — 폴백(미신고)로 흐른다.
        if (it.kind === 'IMAGE' && it.previewUrl) decodeImageSize(it.id, it.previewUrl);
      }
    },
    [runUpload, decodeImageSize],
  );

  const removeItem = useCallback(
    (id: string): void => {
      const target = itemsRef.current.find((it) => it.id === id);
      if (target) {
        revoke(target.previewUrl);
        // FR-AM-28: 제거 시 복구 후보에서도 해제.
        if (target.sessionId) removePendingSessions([target.sessionId]);
      }
      setItems((prev) => prev.filter((it) => it.id !== id));
    },
    [revoke],
  );

  const retryItem = useCallback(
    (id: string): void => {
      const target = itemsRef.current.find((it) => it.id === id);
      if (!target) return;
      const retried: TrayItem = {
        ...target,
        status: 'uploading',
        progress: 0,
        sessionId: null,
        expiresAt: null,
        error: undefined,
      };
      patch(id, {
        status: 'uploading',
        progress: 0,
        sessionId: null,
        expiresAt: null,
        error: undefined,
      });
      void runUpload(retried);
    },
    [patch, runUpload],
  );

  const setAltText = useCallback(
    (id: string, alt: string): void => {
      patch(id, { altText: alt });
    },
    [patch],
  );

  const toggleSpoiler = useCallback((id: string): void => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, isSpoiler: !it.isSpoiler } : it)));
  }, []);

  /**
   * FR-AM-24: presign 잔여 만료가 임계치 미만이면 upload-url 을 재발급한다.
   * 재발급 후에는 객체가 새 storageKey 로 다시 업로드돼야 하므로 단계 2(uploadToStorage)
   * 를 다시 수행한다. 재발급/재업로드 실패는 throw 해 호출자(백오프 루프)가 처리한다.
   * complete 에 쓸 effective sessionId 를 반환한다(refresh 안 했으면 기존 id).
   */
  const refreshIfExpiring = useCallback(
    async (item: TrayItem, now: number): Promise<string> => {
      const currentSessionId = item.sessionId as string;
      if (!item.expiresAt) return currentSessionId;
      const remaining = new Date(item.expiresAt).getTime() - now;
      if (remaining > EXPIRY_REFRESH_THRESHOLD_MS) return currentSessionId;
      // 기존 세션은 더 이상 쓰지 않으므로 복구 후보에서 해제(새 세션이 등록됨).
      if (item.sessionId) removePendingSessions([item.sessionId]);
      const session = await presign(item);
      if (!session) throw new Error('presign refresh failed');
      await uploadToStorage(session.upload, item.file, (percent) => {
        patch(item.id, { progress: percent });
      });
      return session.sessionId;
    },
    [presign, patch],
  );

  /**
   * FR-AM-24: complete 를 지수 백오프(최대 3회 · 총 30초 예산)로 수행한다.
   * 1차 즉시 · 2차 +10s · 3차 +20s. 모든 시도 실패 시 마지막 에러를 throw 한다.
   */
  const completeWithBackoff = useCallback(
    async (body: Parameters<typeof completeUpload>[2]): Promise<{ attachmentIds: string[] }> => {
      let lastErr: unknown;
      for (let attempt = 0; attempt < COMPLETE_MAX_ATTEMPTS; attempt++) {
        if (attempt > 0) await sleep(COMPLETE_BACKOFF_MS[attempt]);
        try {
          return await completeUpload(wsId as string, channelId, body);
        } catch (err) {
          lastErr = err;
        }
      }
      throw lastErr;
    },
    [wsId, channelId],
  );

  const completeAndCollect = useCallback(async (): Promise<string[]> => {
    const ready = itemsRef.current.filter(isReady);
    // 전송할 READY 항목이 없으면 트레이는 그대로 둔다(failed/uploading 보존).
    if (ready.length === 0 || wsId === null) {
      return [];
    }
    // 1) 낙관적 전환: ready → sending(로컬 objectURL 유지).
    for (const it of ready) patch(it.id, { status: 'sending' });

    try {
      // 2) presign on-demand refresh(잔여<10s) — 만료 임박 세션을 재발급/재업로드.
      //    refresh 시 새 sessionId 를 받아 complete 에 그대로 쓴다(state 비동기라
      //    itemsRef 재읽기는 stale 일 수 있음 — 반환값을 신뢰).
      const now = Date.now();
      const effectiveSessionIds: string[] = [];
      for (const it of ready) {
        effectiveSessionIds.push(await refreshIfExpiring(it, now));
      }

      // 3) complete(지수 백오프).
      const { attachmentIds } = await completeWithBackoff({
        targetChannelId: channelId,
        sessions: ready.map((it, index) => ({
          sessionId: effectiveSessionIds[index],
          sortOrder: index,
          ...(it.altText.trim() ? { altText: it.altText.trim() } : {}),
          ...(it.isSpoiler ? { isSpoiler: true } : {}),
          ...(it.width ? { width: it.width } : {}),
          ...(it.height ? { height: it.height } : {}),
        })),
      });

      // 4) CONFIRMED: previewUrl 을 백엔드 프록시 URL 로 교체 + 로컬 objectURL revoke.
      ready.forEach((it, index) => {
        const attachmentId = attachmentIds[index];
        revoke(it.previewUrl);
        patch(it.id, {
          status: 'confirmed',
          previewUrl: attachmentId ? confirmedPreviewUrl(attachmentId) : null,
        });
      });
      // FR-AM-28: complete 성공 → 복구 후보 해제(원 세션 + refresh 후 세션 모두).
      removePendingSessions([...ready.map((it) => it.sessionId as string), ...effectiveSessionIds]);
      return attachmentIds;
    } catch (err) {
      // 5) FAILED: 백오프 소진 — sending → failed + 로컬 objectURL revoke.
      const toast = uploadErrorToast(err);
      for (const it of ready) {
        // previewUrl(로컬 objectURL)은 sending 동안 불변이므로 ready 스냅샷으로 충분.
        revoke(it.previewUrl);
        patch(it.id, { status: 'failed', previewUrl: null, error: toast.body });
        if (it.sessionId) removePendingSessions([it.sessionId]);
      }
      notifyRef.current({ variant: 'danger', ...toast });
      return [];
    }
  }, [wsId, channelId, patch, revoke, refreshIfExpiring, completeWithBackoff]);

  const clearConfirmed = useCallback((): void => {
    for (const it of itemsRef.current) {
      if (it.status === 'confirmed') revoke(it.previewUrl);
    }
    setItems((prev) => prev.filter((it) => it.status !== 'confirmed'));
  }, [revoke]);

  const uploadingCount = items.filter((it) => it.status === 'uploading').length;
  const failedCount = items.filter((it) => it.status === 'failed').length;
  const sendingCount = items.filter((it) => it.status === 'sending').length;

  return {
    items,
    uploadingCount,
    failedCount,
    sendingCount,
    addFiles,
    removeItem,
    retryItem,
    setAltText,
    toggleSpoiler,
    completeAndCollect,
    clearConfirmed,
    reset,
  };
}
