import { useCallback, useEffect, useRef, useState } from 'react';
import type { AttachmentLite } from '@qufox/shared-types';
import { completeUpload, requestUploadUrl, uploadToStorage } from './attachmentApi';
import { uploadErrorToast } from './uploadErrors';

/** 트레이 카드 1개의 라이프사이클 상태. */
export type TrayItemStatus = 'uploading' | 'ready' | 'failed';

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
  /** 이미지 미리보기 objectURL(IMAGE 만). 언마운트/제거 시 revoke. */
  previewUrl: string | null;
  /** 단계 1 완료 후 채워지는 MinIO 업로드 세션 id(complete 에 사용). */
  sessionId: string | null;
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

export interface UseAttachmentUploadResult {
  items: TrayItem[];
  /** 업로드 중(uploading) 항목 수 — 전송 버튼 비활성 판정. */
  uploadingCount: number;
  /** 실패 항목 수. */
  failedCount: number;
  /** 새 파일들을 트레이에 추가하고 업로드를 시작한다. */
  addFiles: (files: File[]) => void;
  removeItem: (id: string) => void;
  retryItem: (id: string) => void;
  setAltText: (id: string, alt: string) => void;
  toggleSpoiler: (id: string) => void;
  /**
   * 전송 시점: READY 항목들을 complete 해 attachmentIds 를 반환하고 트레이를
   * 비운다. complete 실패 시 토스트 + 빈 배열(전송 중단은 호출자 판단). 빈
   * 트레이면 [] 반환(첨부 없는 일반 전송).
   */
  completeAndCollect: () => Promise<string[]>;
  /** 트레이 전체 비우기(채널 전환 등). objectURL revoke 포함. */
  reset: () => void;
}

interface UploadToast {
  variant: 'danger' | 'warning';
  title: string;
  body: string;
}

/**
 * S56 (D11 / FR-AM-02/22) — 첨부 업로드 트레이 상태 + 3단계 업로드 오케스트레이션.
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

  const patch = useCallback((id: string, next: Partial<TrayItem>): void => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...next } : it)));
  }, []);

  /** 단계 1+2 를 한 항목에 대해 실행. 실패 시 status=failed + 토스트. */
  const runUpload = useCallback(
    async (item: TrayItem): Promise<void> => {
      // DM 채널은 채널 nested 첨부 미지원(S54) — 진입 자체를 막아야 하지만 방어적 가드.
      if (wsId === null) {
        patch(item.id, { status: 'failed', error: 'DM 채널은 첨부를 지원하지 않습니다.' });
        return;
      }
      try {
        const { sessions } = await requestUploadUrl(wsId, channelId, {
          filename: item.file.name,
          size: item.file.size,
          mimeType: item.file.type || 'application/octet-stream',
          count: 1,
        });
        const session = sessions[0];
        if (!session) throw new Error('no upload session returned');
        patch(item.id, { sessionId: session.sessionId, progress: 0 });
        await uploadToStorage(session.upload, item.file, (percent) => {
          patch(item.id, { progress: percent });
        });
        patch(item.id, { status: 'ready', progress: 100 });
      } catch (err) {
        const toast = uploadErrorToast(err, item.file.name);
        patch(item.id, { status: 'failed', error: toast.body });
        notify({ variant: 'danger', ...toast });
      }
    },
    [wsId, channelId, patch, notify],
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
          altText: '',
          isSpoiler: false,
        };
      });
      setItems((prev) => [...prev, ...newItems]);
      for (const it of newItems) void runUpload(it);
    },
    [runUpload],
  );

  const removeItem = useCallback(
    (id: string): void => {
      const target = itemsRef.current.find((it) => it.id === id);
      if (target) revoke(target.previewUrl);
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
        error: undefined,
      };
      patch(id, { status: 'uploading', progress: 0, sessionId: null, error: undefined });
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

  const completeAndCollect = useCallback(async (): Promise<string[]> => {
    const ready = itemsRef.current.filter(isReady);
    if (ready.length === 0 || wsId === null) {
      reset();
      return [];
    }
    try {
      const { attachmentIds } = await completeUpload(wsId, channelId, {
        targetChannelId: channelId,
        sessions: ready.map((it, index) => ({
          sessionId: it.sessionId as string,
          sortOrder: index,
          ...(it.altText.trim() ? { altText: it.altText.trim() } : {}),
          ...(it.isSpoiler ? { isSpoiler: true } : {}),
          ...(it.width ? { width: it.width } : {}),
          ...(it.height ? { height: it.height } : {}),
        })),
      });
      reset();
      return attachmentIds;
    } catch (err) {
      const toast = uploadErrorToast(err);
      notify({ variant: 'danger', ...toast });
      return [];
    }
  }, [wsId, channelId, reset, notify]);

  const uploadingCount = items.filter((it) => it.status === 'uploading').length;
  const failedCount = items.filter((it) => it.status === 'failed').length;

  return {
    items,
    uploadingCount,
    failedCount,
    addFiles,
    removeItem,
    retryItem,
    setAltText,
    toggleSpoiler,
    completeAndCollect,
    reset,
  };
}
