// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import type { AttachmentLite } from '@qufox/shared-types';

// attachmentSrc 모킹(프록시 인증 fetch → objectURL). useProxyObjectUrl 가 이를 호출합니다.
const fetchAttachmentObjectUrl = vi.fn();
const downloadAttachment = vi.fn();
vi.mock('./attachmentSrc', () => ({
  fetchAttachmentObjectUrl: (...a: unknown[]) => fetchAttachmentObjectUrl(...a),
  downloadAttachment: (...a: unknown[]) => downloadAttachment(...a),
}));

import { ImageMosaicGrid } from './ImageMosaicGrid';

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
    sizeBytes: 1234,
    originalName: 'pic.png',
    isSpoiler: false,
    sortOrder: 0,
    processingStatus: 'READY',
    ...over,
  } as AttachmentLite;
}

/** id 가 a..z 인 n 장의 READY 이미지(alt = "alt-<id>")를 만든다. */
function images(n: number): AttachmentLite[] {
  return Array.from({ length: n }, (_, i) =>
    img({ id: `id-${i}`, originalName: `pic-${i}.png`, altText: `alt-${i}`, sortOrder: i }),
  );
}

describe('ImageMosaicGrid (S58 D11 FR-AM-09)', () => {
  it('2장 → 셀 2칸 렌더 + data-image-count=2', async () => {
    render(<ImageMosaicGrid images={images(2)} />);
    const grid = screen.getByTestId('image-mosaic-grid');
    expect(grid.getAttribute('data-image-count')).toBe('2');
    expect(screen.getByTestId('mosaic-cell-id-0')).toBeTruthy();
    expect(screen.getByTestId('mosaic-cell-id-1')).toBeTruthy();
    // 각 셀 이미지의 alt 가 렌더된다.
    await waitFor(() => expect(screen.getAllByRole('img').length).toBe(2));
    expect(screen.getByAltText('alt-0')).toBeTruthy();
    expect(screen.getByAltText('alt-1')).toBeTruthy();
  });

  it('3장 → 셀 3칸 + 좌측 큰 셀(index 0)이 row-span-2', () => {
    render(<ImageMosaicGrid images={images(3)} />);
    expect(screen.getByTestId('image-mosaic-grid').getAttribute('data-image-count')).toBe('3');
    expect(screen.getByTestId('mosaic-cell-id-0').className).toContain('row-span-2');
    expect(screen.getByTestId('mosaic-cell-id-1').className).not.toContain('row-span-2');
    expect(screen.getByTestId('mosaic-cell-id-2')).toBeTruthy();
  });

  it('4장 → 셀 4칸(2x2)', () => {
    render(<ImageMosaicGrid images={images(4)} />);
    for (let i = 0; i < 4; i += 1) {
      expect(screen.getByTestId(`mosaic-cell-id-${i}`)).toBeTruthy();
    }
    expect(screen.queryByTestId('mosaic-overflow')).toBeNull();
  });

  it('5장 → 셀 5칸, +N 오버레이 없음', () => {
    render(<ImageMosaicGrid images={images(5)} />);
    for (let i = 0; i < 5; i += 1) {
      expect(screen.getByTestId(`mosaic-cell-id-${i}`)).toBeTruthy();
    }
    // 5장 정확히면 초과분 없음 → 오버레이 미노출.
    expect(screen.queryByTestId('mosaic-overflow')).toBeNull();
  });

  it('7장 → 5칸만 노출 + 5번째 셀에 +2 오버레이(나머지 숨김)', () => {
    render(<ImageMosaicGrid images={images(7)} />);
    // 노출 셀은 5칸(index 0..4)만.
    expect(screen.getByTestId('mosaic-cell-id-4')).toBeTruthy();
    expect(screen.queryByTestId('mosaic-cell-id-5')).toBeNull();
    expect(screen.queryByTestId('mosaic-cell-id-6')).toBeNull();
    const overlay = screen.getByTestId('mosaic-overflow');
    expect(overlay.textContent).toContain('+2');
    expect(overlay.getAttribute('aria-label')).toContain('2장');
    // 오버레이는 5번째 셀(index 4) 안에 있다.
    const cell4 = screen.getByTestId('mosaic-cell-id-4');
    expect(within(cell4).getByTestId('mosaic-overflow')).toBeTruthy();
  });

  it('PENDING 이미지 셀은 스켈레톤(role=img aria-label=처리 중)을 유지', () => {
    const list = [
      img({ id: 'r1', altText: 'ready', sortOrder: 0 }),
      img({ id: 'p1', processingStatus: 'PROCESSING', sortOrder: 1 }),
    ];
    render(<ImageMosaicGrid images={list} />);
    const skel = screen.getByTestId('mosaic-skeleton-p1');
    const skelImg = within(skel).getByRole('img');
    expect(skelImg.getAttribute('aria-label')).toBe('처리 중');
    expect(skelImg.className).toContain('qf-skel');
    // READY 셀은 정상 셀로 렌더.
    expect(screen.getByTestId('mosaic-cell-r1')).toBeTruthy();
  });

  it('onImageOpen 전달 시 셀 이미지 클릭 → 해당 index 로 호출', async () => {
    const onImageOpen = vi.fn();
    render(<ImageMosaicGrid images={images(2)} onImageOpen={onImageOpen} />);
    await waitFor(() => expect(screen.getAllByRole('img').length).toBe(2));
    fireEvent.click(screen.getByAltText('alt-1'));
    expect(onImageOpen).toHaveBeenCalledWith(1);
  });

  it('onImageOpen 전달 시 +N 오버레이 클릭 → index 4 로 호출', () => {
    const onImageOpen = vi.fn();
    render(<ImageMosaicGrid images={images(7)} onImageOpen={onImageOpen} />);
    fireEvent.click(screen.getByTestId('mosaic-overflow'));
    expect(onImageOpen).toHaveBeenCalledWith(4);
  });

  it('onImageOpen 미전달 시 셀 클릭/오버레이 클릭은 무동작(에러 없음)', async () => {
    render(<ImageMosaicGrid images={images(7)} />);
    await waitFor(() => expect(screen.getAllByRole('img').length).toBe(5));
    // 클릭해도 throw 하지 않는다.
    expect(() => fireEvent.click(screen.getByAltText('alt-0'))).not.toThrow();
    // 오버레이는 disabled 라 클릭 핸들러가 없다.
    const overlay = screen.getByTestId('mosaic-overflow') as HTMLButtonElement;
    expect(overlay.disabled).toBe(true);
  });

  it('thumbnailKey 있으면 thumbnail variant, 없으면 download variant 로 fetch', async () => {
    render(
      <ImageMosaicGrid
        images={[
          img({ id: 't1', thumbnailKey: 'thumb/t1', sortOrder: 0 }),
          img({ id: 't2', sortOrder: 1 }),
        ]}
      />,
    );
    await waitFor(() => {
      expect(fetchAttachmentObjectUrl).toHaveBeenCalledWith('t1', 'thumbnail');
      expect(fetchAttachmentObjectUrl).toHaveBeenCalledWith('t2', 'download');
    });
  });
});
