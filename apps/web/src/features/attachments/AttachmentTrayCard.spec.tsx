// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { AttachmentTrayCard } from './AttachmentTrayCard';
import type { TrayItem } from './useAttachmentUpload';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});
afterEach(() => cleanup());

function item(over: Partial<TrayItem> = {}): TrayItem {
  return {
    id: 'i1',
    file: { name: 'photo.png', type: 'image/png', size: 2048 } as unknown as File,
    kind: 'IMAGE',
    status: 'uploading',
    progress: 0,
    previewUrl: 'blob:preview',
    sessionId: null,
    altText: '',
    isSpoiler: false,
    ...over,
  };
}

function renderCard(
  it: TrayItem,
  handlers: Partial<Record<string, ReturnType<typeof vi.fn>>> = {},
) {
  const onRemove = handlers.onRemove ?? vi.fn();
  const onRetry = handlers.onRetry ?? vi.fn();
  const onAltChange = handlers.onAltChange ?? vi.fn();
  const onToggleSpoiler = handlers.onToggleSpoiler ?? vi.fn();
  render(
    <AttachmentTrayCard
      item={it}
      onRemove={onRemove}
      onRetry={onRetry}
      onAltChange={onAltChange}
      onToggleSpoiler={onToggleSpoiler}
    />,
  );
  return { onRemove, onRetry, onAltChange, onToggleSpoiler };
}

describe('AttachmentTrayCard (S56 D11 FR-AM-02/22)', () => {
  it('uploading: progressbar 노출(aria-valuenow=progress)', () => {
    renderCard(item({ status: 'uploading', progress: 42 }));
    const bar = screen.getByTestId('tray-progress-i1');
    expect(bar.getAttribute('role')).toBe('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
  });

  it('ready: progressbar 없음', () => {
    renderCard(item({ status: 'ready', progress: 100 }));
    expect(screen.queryByTestId('tray-progress-i1')).toBeNull();
  });

  it('failed: danger 테두리 + 재시도 버튼', () => {
    const { onRetry } = renderCard(item({ status: 'failed' }));
    const retry = screen.getByTestId('tray-retry-i1');
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledWith('i1');
    const card = screen.getByTestId('tray-card-i1');
    expect(card.className).toContain('var(--danger-400)');
  });

  it('spoiler 토글 버튼 aria-pressed + 콜백', () => {
    const { onToggleSpoiler } = renderCard(item({ status: 'ready' }));
    const btn = screen.getByTestId('tray-spoiler-i1');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(btn);
    expect(onToggleSpoiler).toHaveBeenCalledWith('i1');
  });

  it('spoiler 켜진 이미지 미리보기는 blur 적용', () => {
    renderCard(item({ status: 'ready', isSpoiler: true }));
    const img = screen.getByRole('img');
    expect(img.className).toContain('blur');
  });

  it('alt 토글 → input 노출 + onAltChange', () => {
    const { onAltChange } = renderCard(item({ status: 'ready' }));
    fireEvent.click(screen.getByTestId('tray-alt-toggle-i1'));
    const input = screen.getByTestId('tray-alt-input-i1') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '대체 설명' } });
    expect(onAltChange).toHaveBeenCalledWith('i1', '대체 설명');
  });

  it('제거 버튼 → onRemove(파일명 aria-label)', () => {
    const { onRemove } = renderCard(item({ status: 'ready' }));
    const rm = screen.getByTestId('tray-remove-i1');
    expect(rm.getAttribute('aria-label')).toContain('photo.png');
    fireEvent.click(rm);
    expect(onRemove).toHaveBeenCalledWith('i1');
  });

  it('FILE 종류는 alt 토글 미노출(이미지/비디오만)', () => {
    renderCard(
      item({
        status: 'ready',
        kind: 'FILE',
        previewUrl: null,
        file: { name: 'a.pdf', type: 'application/pdf', size: 10 } as unknown as File,
      }),
    );
    expect(screen.queryByTestId('tray-alt-toggle-i1')).toBeNull();
  });

  it('B-01/B-04: 액션 버튼은 qf-btn--icon--sm(28px·focus-visible) 사용', () => {
    renderCard(item({ status: 'ready' }));
    const remove = screen.getByTestId('tray-remove-i1');
    const spoiler = screen.getByTestId('tray-spoiler-i1');
    expect(remove.className).toContain('qf-btn--icon');
    expect(remove.className).toContain('qf-btn--sm');
    expect(remove.className).not.toContain('qf-row-iconbtn');
    expect(spoiler.className).toContain('qf-btn--icon');
    expect(spoiler.className).not.toContain('qf-row-iconbtn');
  });

  it('B-02: uploading→ready 전환 시 sr-only live 가 "업로드 완료" 통지', async () => {
    const onRemove = vi.fn();
    const { rerender } = render(
      <AttachmentTrayCard
        item={item({ status: 'uploading', progress: 50 })}
        onRemove={onRemove}
        onRetry={vi.fn()}
        onAltChange={vi.fn()}
        onToggleSpoiler={vi.fn()}
      />,
    );
    // 초기엔 무음.
    expect(screen.getByTestId('tray-live-i1').textContent).toBe('');
    rerender(
      <AttachmentTrayCard
        item={item({ status: 'ready', progress: 100 })}
        onRemove={onRemove}
        onRetry={vi.fn()}
        onAltChange={vi.fn()}
        onToggleSpoiler={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('tray-live-i1').textContent).toContain('업로드 완료'),
    );
    expect(screen.getByTestId('tray-live-i1').textContent).toContain('photo.png');
  });

  it('B-02: uploading→failed 전환 시 sr-only live 가 "업로드 실패" 통지', async () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <AttachmentTrayCard
        item={item({ status: 'uploading', progress: 30 })}
        onRemove={vi.fn()}
        onRetry={onRetry}
        onAltChange={vi.fn()}
        onToggleSpoiler={vi.fn()}
      />,
    );
    rerender(
      <AttachmentTrayCard
        item={item({ status: 'failed' })}
        onRemove={vi.fn()}
        onRetry={onRetry}
        onAltChange={vi.fn()}
        onToggleSpoiler={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('tray-live-i1').textContent).toContain('업로드 실패'),
    );
  });
});
