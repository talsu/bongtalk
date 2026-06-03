import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * S56 (D11 / FR-AM-01/21) — 드래그앤드롭 + 붙여넣기 첨부 진입점.
 *
 * 채팅 컬럼 래퍼에 부착할 dragenter/over/leave/drop 핸들러와, document 레벨
 * paste(ClipboardEvent.items 의 image/*) 리스너를 제공합니다. dragover 상태
 * (`isDragging`)로 DropZoneOverlay 표시를 토글합니다.
 *
 * dragenter/leave 가 자식 요소를 가로지를 때마다 발화하는 깜빡임을 막기 위해
 * 진입 카운터(depthRef)로 중첩 enter/leave 를 상쇄합니다(0 이 되면 leave 확정).
 */
export interface UseDropZoneOptions {
  /** 첨부 비활성(공지 채널 게시 제한 등)이면 모든 핸들러가 no-op. */
  disabled?: boolean;
  /** 받은 파일들을 처리하는 콜백(트레이에 추가). */
  onFiles: (files: File[]) => void;
}

export interface UseDropZoneResult {
  isDragging: boolean;
  /** 채팅 컬럼 래퍼에 spread 할 드래그 핸들러들. */
  dragHandlers: {
    onDragEnter: (e: React.DragEvent) => void;
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
  };
}

/** DataTransfer 가 파일을 운반 중인지(텍스트 드래그와 구분). */
function hasFiles(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  // types 는 표준, items 는 일부 브라우저. 둘 중 하나라도 'Files' 면 파일 드래그.
  if (dt.types && Array.from(dt.types).includes('Files')) return true;
  return false;
}

export function useDropZone({ disabled = false, onFiles }: UseDropZoneOptions): UseDropZoneResult {
  const [isDragging, setDragging] = useState(false);
  const depthRef = useRef(0);

  const onDragEnter = useCallback(
    (e: React.DragEvent): void => {
      if (disabled || !hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      depthRef.current += 1;
      setDragging(true);
    },
    [disabled],
  );

  const onDragOver = useCallback(
    (e: React.DragEvent): void => {
      if (disabled || !hasFiles(e.dataTransfer)) return;
      // preventDefault 가 없으면 브라우저가 파일을 새 탭으로 열어버림(drop 차단 필수).
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    },
    [disabled],
  );

  const onDragLeave = useCallback(
    (_e: React.DragEvent): void => {
      if (disabled) return;
      depthRef.current = Math.max(0, depthRef.current - 1);
      if (depthRef.current === 0) setDragging(false);
    },
    [disabled],
  );

  const onDrop = useCallback(
    (e: React.DragEvent): void => {
      if (disabled) return;
      e.preventDefault();
      depthRef.current = 0;
      setDragging(false);
      const files = e.dataTransfer?.files ? Array.from(e.dataTransfer.files) : [];
      if (files.length > 0) onFiles(files);
    },
    [disabled, onFiles],
  );

  // FR-AM-01: 붙여넣기(이미지). composer 가 마운트된 동안 document paste 를 듣고
  // ClipboardItem 중 image/* 만 파일로 추출한다. 텍스트 붙여넣기는 textarea 기본
  // 동작을 막지 않도록 image 가 있을 때만 preventDefault.
  useEffect(() => {
    if (disabled) return;
    const onPaste = (e: ClipboardEvent): void => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (let i = 0; i < items.length; i += 1) {
        const it = items[i];
        if (it.kind === 'file' && it.type.startsWith('image/')) {
          const f = it.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        onFiles(files);
      }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [disabled, onFiles]);

  return {
    isDragging,
    dragHandlers: { onDragEnter, onDragOver, onDragLeave, onDrop },
  };
}
