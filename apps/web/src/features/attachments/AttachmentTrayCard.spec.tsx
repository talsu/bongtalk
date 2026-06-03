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
    expiresAt: null,
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

  it('S57: sending 상태는 "전송 중" 표시 + 제거/액션 disabled(A-05: DOM 유지)', () => {
    renderCard(item({ status: 'sending', progress: 100 }));
    expect(screen.getByTestId('tray-sending-i1').textContent).toContain('전송 중');
    // A-05: 버튼은 DOM 에 남되 disabled — 포커스 소실/상태 미전달 방지.
    const remove = screen.getByTestId('tray-remove-i1') as HTMLButtonElement;
    const spoiler = screen.getByTestId('tray-spoiler-i1') as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    expect(remove.getAttribute('aria-disabled')).toBe('true');
    expect(spoiler.disabled).toBe(true);
    expect(spoiler.getAttribute('aria-disabled')).toBe('true');
    // progressbar 는 sending 에서 미노출.
    expect(screen.queryByTestId('tray-progress-i1')).toBeNull();
  });

  it('S57: confirmed 상태는 "전송 완료" 표시 + 액션 disabled(A-05: DOM 유지)', () => {
    renderCard(item({ status: 'confirmed', previewUrl: null }));
    expect(screen.getByTestId('tray-confirmed-i1').textContent).toContain('전송 완료');
    const remove = screen.getByTestId('tray-remove-i1') as HTMLButtonElement;
    const spoiler = screen.getByTestId('tray-spoiler-i1') as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    expect(spoiler.disabled).toBe(true);
  });

  it('A-02/A-03: sending/confirmed 시각 표시는 aria-hidden(liveMsg 중복 방지)', () => {
    const { rerender } = render(
      <AttachmentTrayCard
        item={item({ status: 'sending', progress: 100 })}
        onRemove={vi.fn()}
        onRetry={vi.fn()}
        onAltChange={vi.fn()}
        onToggleSpoiler={vi.fn()}
      />,
    );
    expect(screen.getByTestId('tray-sending-i1').getAttribute('aria-hidden')).toBe('true');
    rerender(
      <AttachmentTrayCard
        item={item({ status: 'confirmed', previewUrl: null })}
        onRemove={vi.fn()}
        onRetry={vi.fn()}
        onAltChange={vi.fn()}
        onToggleSpoiler={vi.fn()}
      />,
    );
    expect(screen.getByTestId('tray-confirmed-i1').getAttribute('aria-hidden')).toBe('true');
  });

  it('A-01: sr-only live 영역은 aria-atomic="true"', () => {
    renderCard(item({ status: 'uploading', progress: 10 }));
    expect(screen.getByTestId('tray-live-i1').getAttribute('aria-atomic')).toBe('true');
  });

  it('A-07: sending 카드 li 는 aria-busy', () => {
    renderCard(item({ status: 'sending', progress: 100 }));
    expect(screen.getByTestId('tray-card-i1').getAttribute('aria-busy')).toBe('true');
  });

  it('A-08: progressbar 는 aria-valuetext="N%"', () => {
    renderCard(item({ status: 'uploading', progress: 37 }));
    expect(screen.getByTestId('tray-progress-i1').getAttribute('aria-valuetext')).toBe('37%');
  });

  it('A-06: alt 입력 중 locked(sending) 전환 시 input 닫힘(포커스 소실 방지)', () => {
    const noop = vi.fn();
    const { rerender } = render(
      <AttachmentTrayCard
        item={item({ status: 'ready', progress: 100 })}
        onRemove={noop}
        onRetry={noop}
        onAltChange={noop}
        onToggleSpoiler={noop}
      />,
    );
    fireEvent.click(screen.getByTestId('tray-alt-toggle-i1'));
    expect(screen.getByTestId('tray-alt-input-i1')).toBeTruthy();
    rerender(
      <AttachmentTrayCard
        item={item({ status: 'sending', progress: 100 })}
        onRemove={noop}
        onRetry={noop}
        onAltChange={noop}
        onToggleSpoiler={noop}
      />,
    );
    expect(screen.queryByTestId('tray-alt-input-i1')).toBeNull();
  });

  it('S57: ready→sending 전환 시 sr-only live 가 "전송 중" 통지', async () => {
    const noop = vi.fn();
    const { rerender } = render(
      <AttachmentTrayCard
        item={item({ status: 'ready', progress: 100 })}
        onRemove={noop}
        onRetry={noop}
        onAltChange={noop}
        onToggleSpoiler={noop}
      />,
    );
    rerender(
      <AttachmentTrayCard
        item={item({ status: 'sending', progress: 100 })}
        onRemove={noop}
        onRetry={noop}
        onAltChange={noop}
        onToggleSpoiler={noop}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('tray-live-i1').textContent).toContain('전송 중'),
    );
  });

  it('S57: sending→confirmed 전환 시 sr-only live 가 "전송 완료" 통지', async () => {
    const noop = vi.fn();
    const { rerender } = render(
      <AttachmentTrayCard
        item={item({ status: 'sending', progress: 100 })}
        onRemove={noop}
        onRetry={noop}
        onAltChange={noop}
        onToggleSpoiler={noop}
      />,
    );
    rerender(
      <AttachmentTrayCard
        item={item({ status: 'confirmed', previewUrl: '/api/attachments/x/download' })}
        onRemove={noop}
        onRetry={noop}
        onAltChange={noop}
        onToggleSpoiler={noop}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('tray-live-i1').textContent).toContain('전송 완료'),
    );
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
