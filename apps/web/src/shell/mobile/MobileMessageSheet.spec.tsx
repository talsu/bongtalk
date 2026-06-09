// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { MessageDto } from '@qufox/shared-types';
import { MobileMessageSheet } from './MobileMessageSheet';

/**
 * S103 (FR-MSG-06 모바일): long-press 시트의 '메시지 편집' 액션 가시성 + 배선.
 * 호출측이 isMine·!tmp-·!deleted 게이트를 통과한 경우에만 onEdit 을 전달하므로,
 * onEdit 유무로 편집 버튼 노출/숨김이 결정된다(jest-dom 미사용 repo → plain 단언).
 */

function makeMsg(over: Partial<MessageDto> = {}): MessageDto {
  return {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    channelId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    authorId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    content: '내용',
    contentRaw: '내용',
    contentAst: null,
    contentPlain: '내용',
    type: 'DEFAULT',
    deleted: false,
    createdAt: '2025-01-01T00:00:00.000Z',
    version: 1,
    ...over,
  } as MessageDto;
}

const baseProps = {
  onClose: vi.fn(),
  onDelete: vi.fn(),
  onCopy: vi.fn(),
  onReact: vi.fn(),
  onReply: vi.fn(),
};

describe('MobileMessageSheet 편집 액션 (S103)', () => {
  afterEach(() => cleanup());

  it('onEdit 전달 시 "메시지 편집" 버튼 노출 + 탭 시 호출', () => {
    const onEdit = vi.fn();
    render(<MobileMessageSheet msg={makeMsg()} isMine onEdit={onEdit} {...baseProps} />);
    const btn = screen.getByTestId('mobile-msg-edit');
    expect(btn).toBeTruthy();
    fireEvent.click(btn);
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('onEdit 미전달 시 편집 버튼 숨김(삭제는 isMine 이라 노출)', () => {
    render(<MobileMessageSheet msg={makeMsg()} isMine {...baseProps} />);
    expect(screen.queryByTestId('mobile-msg-edit')).toBeNull();
    // 편집 게이트와 삭제 게이트는 독립 — isMine 이면 삭제는 보인다.
    expect(screen.getByTestId('mobile-msg-delete')).toBeTruthy();
  });
});
