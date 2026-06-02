// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { SaveStatus, SavedMessageDto } from '@qufox/shared-types';

// S52 (FR-PS-08): SavedItem 탭별 액션 가용성 + onMove/onUnsave 콜백 검증.
//
// Radix DropdownMenu 는 jsdom 의 pointer-capture / portal 거동이 까다로워(EditHistory
// 팝오버 선례), 드롭다운 primitive 를 항상 children 을 렌더하는 pass-through 로 모킹해
// 탭별 액션 가용성 로직 자체에 집중한다. DropdownItem 은 onSelect 를 onClick 으로 노출해
// fireEvent.click 으로 액션 콜백을 검증한다.
vi.mock('../../design-system/primitives', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../design-system/primitives')>();
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    ...actual,
    DropdownRoot: Pass,
    DropdownTrigger: ({ children }: { children?: ReactNode; asChild?: boolean }) => <>{children}</>,
    DropdownContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    DropdownSeparator: () => <hr />,
    DropdownItem: ({ children, onSelect }: { children?: ReactNode; onSelect?: () => void }) => (
      <button type="button" onClick={() => onSelect?.()}>
        {children}
      </button>
    ),
  };
});

import { SavedItem } from './SavedItem';

function item(over: Partial<SavedMessageDto>): SavedMessageDto {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    messageId: '22222222-2222-2222-2222-222222222222',
    status: 'IN_PROGRESS',
    savedAt: '2025-01-01T00:00:00.000Z',
    messageDeletedAt: null,
    excerpt: 'hello world',
    authorId: '33333333-3333-3333-3333-333333333333',
    channelId: '44444444-4444-4444-4444-444444444444',
    channelName: 'general',
    ...over,
  };
}

const MID = '22222222-2222-2222-2222-222222222222';
const SID = '11111111-1111-1111-1111-111111111111';

function renderItem(status: SaveStatus, over: Partial<SavedMessageDto> = {}) {
  const onUnsave = vi.fn();
  const onMove = vi.fn();
  render(<SavedItem item={item({ status, ...over })} onUnsave={onUnsave} onMove={onMove} />);
  // 드롭다운은 pass-through 모킹이라 항상 children 이 렌더된다(열기 클릭 불요).
  return { onUnsave, onMove };
}

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

afterEach(() => cleanup());

describe('SavedItem 탭별 액션 가용성 (FR-PS-08)', () => {
  it('IN_PROGRESS: 보관·완료·저장해제 가용, 진행중 복원 없음 + 인라인 완료 체크', () => {
    renderItem('IN_PROGRESS');
    // 인라인 완료 체크.
    expect(screen.getByTestId(`saved-complete-${MID}`)).toBeTruthy();
    expect(screen.getByTestId(`saved-action-archive-${MID}`)).toBeTruthy();
    expect(screen.getByTestId(`saved-action-complete-${MID}`)).toBeTruthy();
    expect(screen.getByTestId(`saved-action-unsave-${MID}`)).toBeTruthy();
    expect(screen.queryByTestId(`saved-action-restore-${MID}`)).toBeNull();
  });

  it('ARCHIVED: 진행중 복원·완료·저장해제 가용, 보관 없음 + 인라인 완료 체크', () => {
    renderItem('ARCHIVED');
    expect(screen.getByTestId(`saved-complete-${MID}`)).toBeTruthy();
    expect(screen.getByTestId(`saved-action-restore-${MID}`)).toBeTruthy();
    expect(screen.getByTestId(`saved-action-complete-${MID}`)).toBeTruthy();
    expect(screen.getByTestId(`saved-action-unsave-${MID}`)).toBeTruthy();
    expect(screen.queryByTestId(`saved-action-archive-${MID}`)).toBeNull();
  });

  it('COMPLETED: 진행중 복원·저장해제만 가용, 완료/보관/인라인체크 없음', () => {
    renderItem('COMPLETED');
    expect(screen.queryByTestId(`saved-complete-${MID}`)).toBeNull();
    expect(screen.getByTestId(`saved-action-restore-${MID}`)).toBeTruthy();
    expect(screen.getByTestId(`saved-action-unsave-${MID}`)).toBeTruthy();
    expect(screen.queryByTestId(`saved-action-complete-${MID}`)).toBeNull();
    expect(screen.queryByTestId(`saved-action-archive-${MID}`)).toBeNull();
  });

  it('인라인 완료 체크는 onMove(id, from, COMPLETED)를 호출한다', () => {
    const onUnsave = vi.fn();
    const onMove = vi.fn();
    render(
      <SavedItem item={item({ status: 'IN_PROGRESS' })} onUnsave={onUnsave} onMove={onMove} />,
    );
    fireEvent.click(screen.getByTestId(`saved-complete-${MID}`));
    expect(onMove).toHaveBeenCalledWith(SID, 'IN_PROGRESS', 'COMPLETED');
  });

  it('보관 액션은 onMove(id, from, ARCHIVED)를 호출한다', () => {
    const { onMove } = renderItem('IN_PROGRESS');
    fireEvent.click(screen.getByTestId(`saved-action-archive-${MID}`));
    expect(onMove).toHaveBeenCalledWith(SID, 'IN_PROGRESS', 'ARCHIVED');
  });

  it('저장 해제 액션은 onUnsave(messageId)를 호출한다(영구삭제 = DELETE :messageId)', () => {
    const { onUnsave } = renderItem('COMPLETED');
    fireEvent.click(screen.getByTestId(`saved-action-unsave-${MID}`));
    expect(onUnsave).toHaveBeenCalledWith(MID);
  });

  it('삭제된 원본 항목에도 액션 UI 가 렌더된다(FR-PS-12)', () => {
    renderItem('IN_PROGRESS', {
      messageDeletedAt: '2025-01-01T00:00:00.000Z',
      excerpt: '[삭제된 메시지]',
    });
    // 마스킹 + 액션 모두 존재.
    const li = screen.getByTestId(`saved-item-${MID}`);
    expect(within(li).getByText('[삭제된 메시지]')).toBeTruthy();
    expect(screen.getByTestId(`saved-action-unsave-${MID}`)).toBeTruthy();
    expect(screen.getByTestId(`saved-action-archive-${MID}`)).toBeTruthy();
  });
});
