// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { AttachmentLite } from '@qufox/shared-types';

// attachmentSrc 모킹(프록시 인증 fetch → objectURL).
const fetchAttachmentObjectUrl = vi.fn();
const downloadAttachment = vi.fn();
vi.mock('./attachmentSrc', () => ({
  fetchAttachmentObjectUrl: (...a: unknown[]) => fetchAttachmentObjectUrl(...a),
  downloadAttachment: (...a: unknown[]) => downloadAttachment(...a),
}));

import { AttachmentsList } from './AttachmentsList';

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

function att(over: Partial<AttachmentLite> = {}): AttachmentLite {
  return {
    id: 'a1',
    kind: 'FILE',
    mime: 'application/pdf',
    sizeBytes: 1234,
    originalName: 'file.pdf',
    isSpoiler: false,
    sortOrder: 0,
    processingStatus: 'READY',
    ...over,
  } as AttachmentLite;
}

describe('AttachmentsList (S56 D11 FR-AM-21/22)', () => {
  it('빈 배열이면 렌더 없음', () => {
    const { container } = render(<AttachmentsList attachments={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('PENDING/PROCESSING → qf-skel(role=img aria-label=처리 중)', () => {
    render(<AttachmentsList attachments={[att({ id: 'p1', processingStatus: 'PENDING' })]} />);
    const skel = screen.getByTestId('attachment-skeleton-p1');
    const img = skel.querySelector('[role="img"]');
    expect(img?.getAttribute('aria-label')).toBe('처리 중');
    expect(img?.className).toContain('qf-skel');
  });

  it('READY IMAGE → <img alt=altText> (objectURL fetch)', async () => {
    render(
      <AttachmentsList
        attachments={[att({ id: 'i1', kind: 'IMAGE', mime: 'image/png', altText: '풍경 사진' })]}
      />,
    );
    await waitFor(() => expect(screen.getByRole('img')).toBeTruthy());
    const img = screen.getByRole('img') as HTMLImageElement;
    expect(img.getAttribute('alt')).toBe('풍경 사진');
    expect(fetchAttachmentObjectUrl).toHaveBeenCalledWith('i1', 'download');
  });

  it('thumbnailKey 있으면 thumbnail variant 로 fetch', async () => {
    render(
      <AttachmentsList
        attachments={[
          att({ id: 'i2', kind: 'IMAGE', mime: 'image/png', thumbnailKey: 'thumb/i2' }),
        ]}
      />,
    );
    await waitFor(() => expect(fetchAttachmentObjectUrl).toHaveBeenCalledWith('i2', 'thumbnail'));
  });

  it('IMAGE + isSpoiler → SPOILER 오버레이(reveal 버튼)', async () => {
    render(
      <AttachmentsList
        attachments={[att({ id: 'i3', kind: 'IMAGE', mime: 'image/png', isSpoiler: true })]}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('spoiler-reveal')).toBeTruthy());
    const reveal = screen.getByTestId('spoiler-reveal');
    // B-05: reveal 은 단방향 액션 — aria-pressed 없이 공개 라벨만 노출.
    expect(reveal.getAttribute('aria-pressed')).toBeNull();
    expect(reveal.getAttribute('aria-label')).toContain('스포일러 공개');
  });

  it('FILE + audio/* → <audio controls>', async () => {
    render(
      <AttachmentsList
        attachments={[att({ id: 'au1', kind: 'FILE', mime: 'audio/mpeg', originalName: 's.mp3' })]}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('attachment-audio-au1')).toBeTruthy());
    const audio = screen.getByLabelText('s.mp3 오디오');
    expect(audio.tagName.toLowerCase()).toBe('audio');
  });

  it('FILE → 다운로드 카드(클릭 시 downloadAttachment)', () => {
    render(<AttachmentsList attachments={[att({ id: 'f1', originalName: 'doc.pdf' })]} />);
    const btn = screen.getByTestId('attachment-download-f1');
    expect(btn.getAttribute('aria-label')).toContain('doc.pdf');
    fireEvent.click(btn);
    expect(downloadAttachment).toHaveBeenCalledWith('f1', 'doc.pdf');
  });

  it('VIDEO → 파일 카드(MVP 인라인 미재생)', () => {
    render(
      <AttachmentsList
        attachments={[
          att({ id: 'v1', kind: 'VIDEO', mime: 'video/mp4', originalName: 'clip.mp4' }),
        ]}
      />,
    );
    expect(screen.getByTestId('attachment-file-v1')).toBeTruthy();
    expect(screen.queryByTestId('attachment-audio-v1')).toBeNull();
  });

  it('sortOrder 오름차순으로 렌더', () => {
    render(
      <AttachmentsList
        attachments={[
          att({ id: 'b', originalName: 'b.pdf', sortOrder: 1 }),
          att({ id: 'a', originalName: 'a.pdf', sortOrder: 0 }),
        ]}
      />,
    );
    const cards = screen.getAllByTestId(/attachment-file-/);
    expect(cards[0].getAttribute('data-attachment-id')).toBe('a');
    expect(cards[1].getAttribute('data-attachment-id')).toBe('b');
  });
});
