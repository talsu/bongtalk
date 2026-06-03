// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
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
    // S59 (FR-AM-19): 스포일러는 toggle — aria-pressed 로 공개/숨김 상태를 통지(미공개 false).
    expect(reveal.getAttribute('aria-pressed')).toBe('false');
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

  // ── S58 (D11 · FR-AM-07/09): 단일 이미지 550px · 2장+ 모자이크 라우팅 ─────────
  it('이미지 1장 → 단일 ImageAttachment(max-width 550px), 그리드 미사용', async () => {
    render(<AttachmentsList attachments={[att({ id: 'i1', kind: 'IMAGE', mime: 'image/png' })]} />);
    await waitFor(() => expect(screen.getByTestId('attachment-image-i1')).toBeTruthy());
    expect(screen.queryByTestId('image-mosaic-grid')).toBeNull();
    const image = screen.getByRole('img') as HTMLImageElement;
    // FR-AM-07: 인라인 단일 이미지 max-width 550px.
    expect(image.style.maxWidth).toBe('550px');
  });

  it('이미지 2장 이상 → ImageMosaicGrid 로 라우팅(단일 ImageAttachment 미사용)', () => {
    render(
      <AttachmentsList
        attachments={[
          att({ id: 'i1', kind: 'IMAGE', mime: 'image/png', sortOrder: 0 }),
          att({ id: 'i2', kind: 'IMAGE', mime: 'image/png', sortOrder: 1 }),
        ]}
      />,
    );
    expect(screen.getByTestId('image-mosaic-grid').getAttribute('data-image-count')).toBe('2');
    expect(screen.queryByTestId('attachment-image-i1')).toBeNull();
  });

  it('이미지 + 파일 혼합 → 이미지는 그리드, 파일은 기존 카드로 분리 렌더', () => {
    render(
      <AttachmentsList
        attachments={[
          att({ id: 'i1', kind: 'IMAGE', mime: 'image/png', sortOrder: 0 }),
          att({ id: 'i2', kind: 'IMAGE', mime: 'image/png', sortOrder: 1 }),
          att({
            id: 'f1',
            kind: 'FILE',
            mime: 'application/pdf',
            originalName: 'doc.pdf',
            sortOrder: 2,
          }),
        ]}
      />,
    );
    // 이미지 2장 → 그리드.
    expect(screen.getByTestId('image-mosaic-grid')).toBeTruthy();
    // 파일 카드는 기존대로 유지(회귀).
    expect(screen.getByTestId('attachment-file-f1')).toBeTruthy();
  });

  it('이미지 1장 + 파일 1장 → 단일 이미지 + 파일 카드(그리드 없음)', async () => {
    render(
      <AttachmentsList
        attachments={[
          att({ id: 'i1', kind: 'IMAGE', mime: 'image/png', sortOrder: 0 }),
          att({
            id: 'f1',
            kind: 'FILE',
            mime: 'application/pdf',
            originalName: 'doc.pdf',
            sortOrder: 1,
          }),
        ]}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('attachment-image-i1')).toBeTruthy());
    expect(screen.queryByTestId('image-mosaic-grid')).toBeNull();
    expect(screen.getByTestId('attachment-file-f1')).toBeTruthy();
  });

  it('PENDING 단일 이미지 → 스켈레톤 유지(그리드 미사용)', () => {
    render(
      <AttachmentsList
        attachments={[
          att({ id: 'p1', kind: 'IMAGE', mime: 'image/png', processingStatus: 'PENDING' }),
        ]}
      />,
    );
    const skel = screen.getByTestId('attachment-skeleton-p1');
    const img = skel.querySelector('[role="img"]');
    expect(img?.getAttribute('aria-label')).toBe('처리 중');
    expect(screen.queryByTestId('image-mosaic-grid')).toBeNull();
  });

  // ── S58 fix-forward ─────────────────────────────────────────────────────────
  it('I(P-03): <ul> 에 aria-label="첨부 파일"', () => {
    render(<AttachmentsList attachments={[att({ id: 'f1' })]} />);
    const ul = screen.getByTestId('message-attachments');
    expect(ul.getAttribute('aria-label')).toBe('첨부 파일');
  });

  it('M-01: 2장+ 그리드는 <li> 로 감싸 렌더(image-mosaic-grid-item)', () => {
    render(
      <AttachmentsList
        attachments={[
          att({ id: 'i1', kind: 'IMAGE', mime: 'image/png', sortOrder: 0 }),
          att({ id: 'i2', kind: 'IMAGE', mime: 'image/png', sortOrder: 1 }),
        ]}
      />,
    );
    const li = screen.getByTestId('image-mosaic-grid-item');
    expect(li.tagName.toLowerCase()).toBe('li');
    // 그리드 group div 는 li 내부에 위치.
    expect(li.querySelector('[data-testid="image-mosaic-grid"]')).toBeTruthy();
  });

  it('reviewer M1: 단일 BLOCKED 이미지 → fetch 없이 "차단된 파일" 표시', () => {
    render(
      <AttachmentsList
        attachments={[
          att({ id: 'b1', kind: 'IMAGE', mime: 'image/png', processingStatus: 'BLOCKED' }),
        ]}
      />,
    );
    const cell = screen.getByTestId('attachment-unavailable-b1');
    expect(cell.getAttribute('data-status')).toBe('BLOCKED');
    expect(within(cell).getByRole('img').getAttribute('aria-label')).toBe('차단된 파일');
    expect(fetchAttachmentObjectUrl).not.toHaveBeenCalled();
  });

  it('reviewer M1: 단일 FAILED 이미지 → fetch 없이 "처리 실패" 표시', () => {
    render(
      <AttachmentsList
        attachments={[
          att({ id: 'fl1', kind: 'IMAGE', mime: 'image/png', processingStatus: 'FAILED' }),
        ]}
      />,
    );
    const cell = screen.getByTestId('attachment-unavailable-fl1');
    expect(within(cell).getByRole('img').getAttribute('aria-label')).toBe('처리 실패');
    expect(fetchAttachmentObjectUrl).not.toHaveBeenCalled();
  });

  it('B-05: 단일 이미지 로드 실패 시 role="alert"', async () => {
    fetchAttachmentObjectUrl.mockReset().mockRejectedValue(new Error('4xx'));
    render(<AttachmentsList attachments={[att({ id: 'i1', kind: 'IMAGE', mime: 'image/png' })]} />);
    await waitFor(() => expect(screen.getByTestId('attachment-error-i1')).toBeTruthy());
    const err = screen.getByRole('alert');
    expect(err.textContent).toContain('첨부를 불러오지 못했습니다.');
  });

  it('H-01: 단일 이미지 altText 가 빈 문자열이면 originalName 폴백', async () => {
    render(
      <AttachmentsList
        attachments={[
          att({ id: 'i1', kind: 'IMAGE', mime: 'image/png', altText: '', originalName: 'p.png' }),
        ]}
      />,
    );
    await waitFor(() => expect(screen.getByAltText('p.png')).toBeTruthy());
  });

  it('M-03: 단일 이미지 PENDING 스켈레톤에 aria-busy="true"', () => {
    render(
      <AttachmentsList
        attachments={[
          att({ id: 'p1', kind: 'IMAGE', mime: 'image/png', processingStatus: 'PENDING' }),
        ]}
      />,
    );
    const img = screen.getByTestId('attachment-skeleton-p1').querySelector('[role="img"]');
    expect(img?.getAttribute('aria-busy')).toBe('true');
  });

  // ── S59 (D11 · FR-AM-10): 라이트박스 트리거 ──────────────────────────────────
  it('S59: 단일 READY 이미지는 <button> 트리거(image-trigger)로 감싸짐', async () => {
    render(<AttachmentsList attachments={[att({ id: 'i1', kind: 'IMAGE', mime: 'image/png' })]} />);
    const trigger = await screen.findByTestId('image-trigger-i1');
    expect(trigger.tagName.toLowerCase()).toBe('button');
    // 트리거 안에 img 가 들어 있다.
    expect(trigger.querySelector('img')).toBeTruthy();
  });

  it('S59: 단일 이미지 트리거 클릭 → 라이트박스 오픈(role=dialog)', async () => {
    render(<AttachmentsList attachments={[att({ id: 'i1', kind: 'IMAGE', mime: 'image/png' })]} />);
    fireEvent.click(await screen.findByTestId('image-trigger-i1'));
    expect(await screen.findByTestId('lightbox')).toBeTruthy();
    expect(screen.getByTestId('lightbox-counter').textContent?.replace(/\s/g, '')).toBe('1/1');
  });

  it('S59: 그리드 셀 클릭 → 라이트박스 오픈 + 클릭한 index 로 시작', async () => {
    render(
      <AttachmentsList
        attachments={[
          att({ id: 'i1', kind: 'IMAGE', mime: 'image/png', sortOrder: 0 }),
          att({ id: 'i2', kind: 'IMAGE', mime: 'image/png', sortOrder: 1 }),
          att({ id: 'i3', kind: 'IMAGE', mime: 'image/png', sortOrder: 2 }),
        ]}
      />,
    );
    fireEvent.click(await screen.findByTestId('mosaic-trigger-i2'));
    expect(await screen.findByTestId('lightbox')).toBeTruthy();
    // 두 번째 이미지(index 1)에서 시작 → "2 / 3".
    expect(screen.getByTestId('lightbox-counter').textContent?.replace(/\s/g, '')).toBe('2/3');
  });

  it('S59: READY 아닌 이미지(PENDING/BLOCKED)는 라이트박스 슬라이드에서 제외', async () => {
    render(
      <AttachmentsList
        attachments={[
          att({ id: 'r1', kind: 'IMAGE', mime: 'image/png', sortOrder: 0 }),
          att({
            id: 'p1',
            kind: 'IMAGE',
            mime: 'image/png',
            processingStatus: 'PENDING',
            sortOrder: 1,
          }),
          att({ id: 'r2', kind: 'IMAGE', mime: 'image/png', sortOrder: 2 }),
        ]}
      />,
    );
    // 그리드에서 READY 인 r2(전체 index 2) 클릭 → 라이트박스 READY-only 배열(r1,r2)에서 2/2.
    fireEvent.click(await screen.findByTestId('mosaic-trigger-r2'));
    expect(await screen.findByTestId('lightbox')).toBeTruthy();
    // PENDING 제외 → READY 2장 중 두 번째.
    expect(screen.getByTestId('lightbox-counter').textContent?.replace(/\s/g, '')).toBe('2/2');
  });

  it('S59: 스포일러 단일 이미지는 트리거 button 으로 감싸지 않음(스포일러 토글 우선)', async () => {
    render(
      <AttachmentsList
        attachments={[att({ id: 's1', kind: 'IMAGE', mime: 'image/png', isSpoiler: true })]}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('spoiler-reveal')).toBeTruthy());
    // 스포일러는 image-trigger 로 감싸지 않는다(공개 전 클릭은 스포일러 reveal 이 받음).
    expect(screen.queryByTestId('image-trigger-s1')).toBeNull();
  });
});
