// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type React from 'react';
import { useDropZone } from './useDropZone';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});
afterEach(() => {
  vi.restoreAllMocks();
});

const fileOf = (name: string, type: string): File => ({ name, type, size: 1 }) as unknown as File;

/** 파일 드래그 DataTransfer 목(types 에 'Files' 포함). */
function fileDrag(files: File[]): DataTransfer {
  return {
    types: ['Files'],
    files: files as unknown as FileList,
    dropEffect: 'none',
  } as unknown as DataTransfer;
}

function dragEvent(dt: DataTransfer): React.DragEvent {
  return { preventDefault: vi.fn(), dataTransfer: dt } as unknown as React.DragEvent;
}

describe('useDropZone (S56 D11 FR-AM-01/21)', () => {
  it('toggles isDragging on enter/leave with file payload', () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => useDropZone({ onFiles }));
    expect(result.current.isDragging).toBe(false);
    act(() => result.current.dragHandlers.onDragEnter(dragEvent(fileDrag([]))));
    expect(result.current.isDragging).toBe(true);
    act(() => result.current.dragHandlers.onDragLeave(dragEvent(fileDrag([]))));
    expect(result.current.isDragging).toBe(false);
  });

  it('balances nested enter/leave (no flicker until depth 0)', () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => useDropZone({ onFiles }));
    act(() => result.current.dragHandlers.onDragEnter(dragEvent(fileDrag([]))));
    act(() => result.current.dragHandlers.onDragEnter(dragEvent(fileDrag([])))); // child enter
    act(() => result.current.dragHandlers.onDragLeave(dragEvent(fileDrag([])))); // child leave
    expect(result.current.isDragging).toBe(true); // still dragging (depth 1)
    act(() => result.current.dragHandlers.onDragLeave(dragEvent(fileDrag([]))));
    expect(result.current.isDragging).toBe(false);
  });

  it('drop hands files to onFiles and clears dragging', () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => useDropZone({ onFiles }));
    const f = fileOf('a.png', 'image/png');
    act(() => result.current.dragHandlers.onDragEnter(dragEvent(fileDrag([f]))));
    act(() => result.current.dragHandlers.onDrop(dragEvent(fileDrag([f]))));
    expect(onFiles).toHaveBeenCalledWith([f]);
    expect(result.current.isDragging).toBe(false);
  });

  it('ignores non-file drags (text)', () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => useDropZone({ onFiles }));
    const textDt = { types: ['text/plain'], files: [] } as unknown as DataTransfer;
    act(() => result.current.dragHandlers.onDragEnter(dragEvent(textDt)));
    expect(result.current.isDragging).toBe(false);
  });

  it('disabled → handlers are no-ops', () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => useDropZone({ disabled: true, onFiles }));
    const f = fileOf('a.png', 'image/png');
    act(() => result.current.dragHandlers.onDragEnter(dragEvent(fileDrag([f]))));
    act(() => result.current.dragHandlers.onDrop(dragEvent(fileDrag([f]))));
    expect(result.current.isDragging).toBe(false);
    expect(onFiles).not.toHaveBeenCalled();
  });

  it('paste: extracts image/* clipboard items as files', () => {
    const onFiles = vi.fn();
    renderHook(() => useDropZone({ onFiles }));
    const img = fileOf('pasted.png', 'image/png');
    const items = [
      { kind: 'file', type: 'image/png', getAsFile: () => img },
      { kind: 'string', type: 'text/plain', getAsFile: () => null },
    ];
    const ev = new Event('paste') as ClipboardEvent;
    Object.defineProperty(ev, 'clipboardData', {
      value: { items },
      configurable: true,
    });
    const prevent = vi.spyOn(ev, 'preventDefault');
    act(() => {
      document.dispatchEvent(ev);
    });
    expect(onFiles).toHaveBeenCalledWith([img]);
    expect(prevent).toHaveBeenCalled();
  });

  it('paste: text-only clipboard is ignored (no preventDefault)', () => {
    const onFiles = vi.fn();
    renderHook(() => useDropZone({ onFiles }));
    const ev = new Event('paste') as ClipboardEvent;
    Object.defineProperty(ev, 'clipboardData', {
      value: { items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }] },
      configurable: true,
    });
    const prevent = vi.spyOn(ev, 'preventDefault');
    act(() => {
      document.dispatchEvent(ev);
    });
    expect(onFiles).not.toHaveBeenCalled();
    expect(prevent).not.toHaveBeenCalled();
  });
});
