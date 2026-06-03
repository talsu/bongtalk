// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { AttachmentLite } from '@qufox/shared-types';

// attachmentSrc 모킹 — useProxyObjectUrl 이 fetchAttachmentObjectUrl 을 호출하고,
// 다운로드 버튼이 downloadAttachment 를 호출합니다.
const fetchAttachmentObjectUrl = vi.fn();
const downloadAttachment = vi.fn();
vi.mock('./attachmentSrc', () => ({
  fetchAttachmentObjectUrl: (...a: unknown[]) => fetchAttachmentObjectUrl(...a),
  downloadAttachment: (...a: unknown[]) => downloadAttachment(...a),
}));

import { ImageLightbox } from './ImageLightbox';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  fetchAttachmentObjectUrl.mockReset().mockResolvedValue('blob:img');
  downloadAttachment.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('URL', { revokeObjectURL: vi.fn(), createObjectURL: vi.fn() });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function img(over: Partial<AttachmentLite> = {}): AttachmentLite {
  return {
    id: 'i1',
    kind: 'IMAGE',
    mime: 'image/png',
    sizeBytes: 2048,
    originalName: 'pic.png',
    isSpoiler: false,
    sortOrder: 0,
    processingStatus: 'READY',
    ...over,
  } as AttachmentLite;
}

function images(n: number): AttachmentLite[] {
  return Array.from({ length: n }, (_, i) =>
    img({ id: `id-${i}`, originalName: `pic-${i}.png`, altText: `alt-${i}`, sortOrder: i }),
  );
}

describe('ImageLightbox (S59 D11 FR-AM-10/11/12)', () => {
  it('이미지 0장이면 아무것도 렌더하지 않음', () => {
    const { container } = render(
      <ImageLightbox images={[]} open initialIndex={0} onClose={vi.fn()} />,
    );
    expect(container.querySelector('[data-testid="lightbox"]')).toBeNull();
  });

  it('open 시 dialog 시맨틱(role=dialog, aria-modal, aria-label=이미지 뷰어)', async () => {
    render(<ImageLightbox images={images(2)} open initialIndex={0} onClose={vi.fn()} />);
    const dialog = await screen.findByTestId('lightbox');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBe('이미지 뷰어');
  });

  it('FR-AM-10: 오픈 직후 첫 포커스는 닫기 버튼', async () => {
    render(<ImageLightbox images={images(2)} open initialIndex={0} onClose={vi.fn()} />);
    const close = await screen.findByTestId('lightbox-close');
    await waitFor(() => expect(document.activeElement).toBe(close));
  });

  it('FR-AM-10: 하단 "N / M" + 파일명 + 크기 캡션', async () => {
    render(<ImageLightbox images={images(3)} open initialIndex={1} onClose={vi.fn()} />);
    const counter = await screen.findByTestId('lightbox-counter');
    expect(counter.textContent?.replace(/\s/g, '')).toBe('2/3');
    const caption = screen.getByTestId('lightbox-caption');
    expect(caption.textContent).toContain('pic-1.png');
    expect(caption.textContent).toContain('2.0 KB');
  });

  it('FR-AM-10: ArrowRight/ArrowLeft 로 인덱스 이동', async () => {
    render(<ImageLightbox images={images(3)} open initialIndex={0} onClose={vi.fn()} />);
    const dialog = await screen.findByTestId('lightbox');
    expect(screen.getByTestId('lightbox-counter').textContent?.replace(/\s/g, '')).toBe('1/3');
    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    expect(screen.getByTestId('lightbox-counter').textContent?.replace(/\s/g, '')).toBe('2/3');
    fireEvent.keyDown(dialog, { key: 'ArrowLeft' });
    expect(screen.getByTestId('lightbox-counter').textContent?.replace(/\s/g, '')).toBe('1/3');
  });

  it('FR-AM-10: 첫 장 ArrowLeft / 마지막 장 ArrowRight 는 무변화(순환 없음)', async () => {
    render(<ImageLightbox images={images(2)} open initialIndex={0} onClose={vi.fn()} />);
    const dialog = await screen.findByTestId('lightbox');
    // 첫 장에서 ArrowLeft → 1/2 유지.
    fireEvent.keyDown(dialog, { key: 'ArrowLeft' });
    expect(screen.getByTestId('lightbox-counter').textContent?.replace(/\s/g, '')).toBe('1/2');
    // 마지막으로 이동 후 ArrowRight → 2/2 유지.
    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    expect(screen.getByTestId('lightbox-counter').textContent?.replace(/\s/g, '')).toBe('2/2');
  });

  it('FR-AM-10: 첫 장이면 prev 버튼 disabled, 마지막 장이면 next 버튼 disabled', async () => {
    render(<ImageLightbox images={images(2)} open initialIndex={0} onClose={vi.fn()} />);
    const prev = (await screen.findByTestId('lightbox-prev')) as HTMLButtonElement;
    const next = screen.getByTestId('lightbox-next') as HTMLButtonElement;
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(false);
    fireEvent.click(next);
    expect((screen.getByTestId('lightbox-prev') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('lightbox-next') as HTMLButtonElement).disabled).toBe(true);
  });

  it('FR-AM-10: 닫기 버튼 클릭 → onClose 호출', async () => {
    const onClose = vi.fn();
    render(<ImageLightbox images={images(2)} open initialIndex={0} onClose={onClose} />);
    fireEvent.click(await screen.findByTestId('lightbox-close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('FR-AM-10: Esc 키 → onClose 호출(Radix)', async () => {
    const onClose = vi.fn();
    render(<ImageLightbox images={images(2)} open initialIndex={0} onClose={onClose} />);
    await screen.findByTestId('lightbox');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('FR-AM-12: 다운로드 버튼 → downloadAttachment(id, originalName) 호출', async () => {
    render(<ImageLightbox images={images(2)} open initialIndex={1} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('lightbox-download'));
    expect(downloadAttachment).toHaveBeenCalledWith('id-1', 'pic-1.png');
  });

  it('FR-AM-12: 비-SVG 는 원본 열기 버튼 렌더', async () => {
    render(
      <ImageLightbox
        images={[img({ mime: 'image/png' })]}
        open
        initialIndex={0}
        onClose={vi.fn()}
      />,
    );
    expect(await screen.findByTestId('lightbox-open-original')).toBeTruthy();
  });

  it('FR-AM-12: SVG 는 원본 열기 버튼 미렌더(XSS 방어) + 다운로드만', async () => {
    render(
      <ImageLightbox
        images={[img({ mime: 'image/svg+xml', originalName: 'x.svg' })]}
        open
        initialIndex={0}
        onClose={vi.fn()}
      />,
    );
    await screen.findByTestId('lightbox');
    expect(screen.queryByTestId('lightbox-open-original')).toBeNull();
    // 다운로드 버튼은 여전히 존재.
    expect(screen.getByTestId('lightbox-download')).toBeTruthy();
  });

  it('FR-AM-12: storedMimeType=image/svg+xml(신고 mime 와 달라도) 도 원본 열기 미렌더', async () => {
    render(
      <ImageLightbox
        images={[img({ mime: 'image/png', storedMimeType: 'image/svg+xml' })]}
        open
        initialIndex={0}
        onClose={vi.fn()}
      />,
    );
    await screen.findByTestId('lightbox');
    expect(screen.queryByTestId('lightbox-open-original')).toBeNull();
  });

  it('FR-AM-12: 원본 열기 버튼 클릭 → window.open(objectUrl, _blank, noopener,noreferrer)', async () => {
    const openSpy = vi.fn();
    vi.stubGlobal('open', openSpy);
    render(<ImageLightbox images={[img()]} open initialIndex={0} onClose={vi.fn()} />);
    const btn = await screen.findByTestId('lightbox-open-original');
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(btn);
    expect(openSpy).toHaveBeenCalledWith('blob:img', '_blank', 'noopener,noreferrer');
  });

  it('FR-AM-11: 휠로 zoom 변경 → 이미지 transform scale 반영', async () => {
    render(<ImageLightbox images={[img()]} open initialIndex={0} onClose={vi.fn()} />);
    const stage = await screen.findByTestId('lightbox-stage');
    const image = await screen.findByTestId('lightbox-image');
    expect(image.style.transform).toContain('scale(1)');
    fireEvent.wheel(stage, { deltaY: -1 }); // 확대.
    expect(image.style.transform).toContain('scale(1.15)');
  });

  it('FR-AM-11: 휠 zoom 하한 0.5 클램프', async () => {
    render(<ImageLightbox images={[img()]} open initialIndex={0} onClose={vi.fn()} />);
    const stage = await screen.findByTestId('lightbox-stage');
    for (let i = 0; i < 20; i += 1) fireEvent.wheel(stage, { deltaY: 1 }); // 강하게 축소.
    const image = screen.getByTestId('lightbox-image');
    expect(image.style.transform).toContain('scale(0.5)');
  });

  it('FR-AM-11: transform-origin center', async () => {
    render(<ImageLightbox images={[img()]} open initialIndex={0} onClose={vi.fn()} />);
    const image = await screen.findByTestId('lightbox-image');
    expect(image.style.transformOrigin).toBe('center');
  });

  it('FR-AM-11: 이미지 교체(ArrowRight) 시 zoom 리셋(scale(1))', async () => {
    render(<ImageLightbox images={images(2)} open initialIndex={0} onClose={vi.fn()} />);
    const dialog = await screen.findByTestId('lightbox');
    const stage = screen.getByTestId('lightbox-stage');
    await screen.findByTestId('lightbox-image');
    fireEvent.wheel(stage, { deltaY: -1 });
    expect(screen.getByTestId('lightbox-image').style.transform).toContain('scale(1.15)');
    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    // 교체된 이미지의 src 가 다시 로드되므로 lightbox-image 재등장을 기다립니다.
    await waitFor(() =>
      expect(screen.getByTestId('lightbox-image').style.transform).toContain('scale(1)'),
    );
  });

  it('이미지 로드 실패 시 role="alert" 표시', async () => {
    fetchAttachmentObjectUrl.mockReset().mockRejectedValue(new Error('4xx'));
    render(<ImageLightbox images={[img()]} open initialIndex={0} onClose={vi.fn()} />);
    const err = await screen.findByTestId('lightbox-error');
    expect(err.getAttribute('role')).toBe('alert');
  });

  it('라이트박스는 원본(download) 변형을 fetch(thumbnail 아님)', async () => {
    render(
      <ImageLightbox
        images={[img({ id: 'z1', thumbnailKey: 'thumb/z1' })]}
        open
        initialIndex={0}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => expect(fetchAttachmentObjectUrl).toHaveBeenCalledWith('z1', 'download'));
    expect(fetchAttachmentObjectUrl).not.toHaveBeenCalledWith('z1', 'thumbnail');
  });
});
