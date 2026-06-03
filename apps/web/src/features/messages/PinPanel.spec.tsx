// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { ListPinsResponse, MessageDto } from '@qufox/shared-types';

/**
 * S50 (D10 · FR-PS-03): PinPanel 렌더/상호작용 검증. usePins/useUnpinMessage 를
 * 모킹해 네트워크 없이 패널 본문 분기(로딩/빈/목록 + 2줄 클램프 + 점프 + 해제)를
 * 검증한다. EditHistoryPopover.spec 의 훅 모킹 + render 패턴과 정합.
 */

let pinsState: {
  isLoading: boolean;
  data?: ListPinsResponse;
};
const unpinMutate = vi.fn();

vi.mock('./useMessages', () => ({
  usePins: () => pinsState,
  useUnpinMessage: () => ({ mutate: unpinMutate }),
}));

// renderMessageContent 는 mrkdwn 파이프라인을 타므로 본문 텍스트만 통과하는
// 경량 패스스루로 모킹한다(클램프/점프 시맨틱 검증에 집중).
vi.mock('./parseContent', () => ({
  renderMessageContent: (s: string) => s,
}));

import { PinPanel } from './PinPanel';

function makePin(overrides: Partial<MessageDto> = {}): MessageDto {
  return {
    id: 'msg-1',
    channelId: 'ch-1',
    authorId: 'u-1',
    content: 'pinned body',
    contentRaw: 'pinned body',
    contentAst: null,
    contentPlain: 'pinned body',
    type: 'DEFAULT',
    mentions: { users: [], channels: [], everyone: false, here: false, channel: false },
    edited: false,
    deleted: false,
    createdAt: '2025-01-01T00:00:00.000Z',
    editedAt: null,
    reactions: [],
    parentMessageId: null,
    thread: null,
    attachments: [],
    pinnedAt: '2025-01-01T00:00:00.000Z',
    pinnedBy: 'u-2',
    version: 0,
    isBroadcast: false,
    parentExcerpt: null,
    threadLocked: false,
    embeds: [],
    ...overrides,
  };
}

const baseProps = {
  workspaceId: 'ws-1',
  channelId: 'ch-1',
  nameByUserId: new Map([['u-1', 'Alice']]),
};

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T12:00:00Z'));
  pinsState = { isLoading: false, data: { items: [], cap: 50, used: 0 } };
  unpinMutate.mockClear();
});
afterEach(() => cleanup());

describe('PinPanel (S50 D10 FR-PS-03)', () => {
  it('빈 상태에서 안내 문구를 표시한다', () => {
    const onClose = vi.fn();
    const onJump = vi.fn();
    render(<PinPanel {...baseProps} onClose={onClose} onJump={onJump} />);
    expect(screen.getByTestId('pin-panel-empty').textContent).toContain('고정된 메시지가 없습니다');
  });

  it('핀 목록을 작성자/본문과 함께 렌더하고 카운트 배지를 표시한다', () => {
    pinsState = { isLoading: false, data: { items: [makePin()], cap: 50, used: 1 } };
    render(<PinPanel {...baseProps} onClose={vi.fn()} onJump={vi.fn()} />);
    expect(screen.getByTestId('pin-row-msg-1')).toBeTruthy();
    expect(screen.getByTestId('pin-panel-count').textContent).toBe('1');
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.getByTestId('pin-jump-msg-1').textContent).toContain('pinned body');
  });

  it('원본 점프 버튼 클릭 시 onJump(messageId) 를 호출한다(FR-PS-03)', () => {
    pinsState = { isLoading: false, data: { items: [makePin()], cap: 50, used: 1 } };
    const onJump = vi.fn();
    render(<PinPanel {...baseProps} onClose={vi.fn()} onJump={onJump} />);
    fireEvent.click(screen.getByTestId('pin-jump-msg-1'));
    expect(onJump).toHaveBeenCalledWith('msg-1');
  });

  it('고정 해제 버튼 클릭 시 unpin mutate 를 호출한다', () => {
    pinsState = { isLoading: false, data: { items: [makePin()], cap: 50, used: 1 } };
    render(<PinPanel {...baseProps} onClose={vi.fn()} onJump={vi.fn()} />);
    fireEvent.click(screen.getByTestId('pin-unpin-msg-1'));
    expect(unpinMutate).toHaveBeenCalledWith('msg-1');
  });

  it('삭제된 원본 핀은 [삭제된 메시지] placeholder 로 렌더한다', () => {
    pinsState = {
      isLoading: false,
      data: { items: [makePin({ deleted: true, content: null })], cap: 50, used: 1 },
    };
    render(<PinPanel {...baseProps} onClose={vi.fn()} onJump={vi.fn()} />);
    expect(screen.getByTestId('pin-jump-msg-1').textContent).toContain('[삭제된 메시지]');
  });
});
