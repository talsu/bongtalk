// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { MessageDto } from '@qufox/shared-types';
import { MobileEditSheet } from './MobileEditSheet';

/**
 * S103 (FR-MSG-06 모바일): 메시지 편집 바텀시트. 데스크톱 인라인 편집의 모바일
 * 대응. 저장은 trim 된 본문을 onSave(부모 updMut.mutateAsync)로 위임하고, 변경
 * 없음/빈 본문/전송 중엔 비활성한다. 충돌/검증 실패(reject)는 시트를 유지한다.
 *
 * 이 컴포넌트는 시간/타이머를 읽지 않으므로 fake timers 를 쓰지 않는다(repo 의
 * setSystemTime 규약은 시간 의존 코드 대상). jest-dom 미사용 repo 라 plain DOM
 * 속성으로 단언한다(.disabled / .value).
 */

function makeMsg(over: Partial<MessageDto> = {}): MessageDto {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    channelId: '22222222-2222-2222-2222-222222222222',
    authorId: '33333333-3333-3333-3333-333333333333',
    content: '원본 내용',
    contentRaw: '원본 내용',
    contentAst: null,
    contentPlain: '원본 내용',
    type: 'DEFAULT',
    deleted: false,
    createdAt: '2025-01-01T00:00:00.000Z',
    version: 3,
    ...over,
  } as MessageDto;
}

const ta = (): HTMLTextAreaElement => screen.getByTestId('mobile-edit-input') as HTMLTextAreaElement;
const saveBtn = (): HTMLButtonElement => screen.getByTestId('mobile-edit-save') as HTMLButtonElement;

describe('MobileEditSheet (S103 · FR-MSG-06 모바일)', () => {
  afterEach(() => cleanup());

  it('현재 본문을 채우고, 변경 없음이면 저장 비활성', () => {
    render(<MobileEditSheet msg={makeMsg()} onCancel={vi.fn()} onSave={vi.fn()} />);
    expect(ta().value).toBe('원본 내용');
    expect(saveBtn().disabled).toBe(true);
  });

  it('빈 본문이면 저장 비활성', () => {
    render(<MobileEditSheet msg={makeMsg()} onCancel={vi.fn()} onSave={vi.fn()} />);
    fireEvent.change(ta(), { target: { value: '   ' } });
    expect(saveBtn().disabled).toBe(true);
  });

  it('내용 변경 후 저장 → trim 된 본문으로 onSave 호출', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<MobileEditSheet msg={makeMsg()} onCancel={vi.fn()} onSave={onSave} />);
    fireEvent.change(ta(), { target: { value: '  수정됨  ' } });
    expect(saveBtn().disabled).toBe(false);
    fireEvent.click(saveBtn());
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('수정됨'));
  });

  it('취소 버튼 → onCancel', () => {
    const onCancel = vi.fn();
    render(<MobileEditSheet msg={makeMsg()} onCancel={onCancel} onSave={vi.fn()} />);
    fireEvent.click(screen.getByTestId('mobile-edit-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('Escape → onCancel', () => {
    const onCancel = vi.fn();
    render(<MobileEditSheet msg={makeMsg()} onCancel={onCancel} onSave={vi.fn()} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('백드롭 탭 → onCancel', () => {
    const onCancel = vi.fn();
    const { container } = render(
      <MobileEditSheet msg={makeMsg()} onCancel={onCancel} onSave={vi.fn()} />,
    );
    const backdrop = container.querySelector('.qf-m-sheet-backdrop');
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop!);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('저장 실패(reject)면 시트를 유지하고 저장 버튼을 다시 활성화', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('CONFLICT'));
    render(<MobileEditSheet msg={makeMsg()} onCancel={vi.fn()} onSave={onSave} />);
    fireEvent.change(ta(), { target: { value: '수정됨' } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    // 실패 후 시트 유지 + 입력 보존 + 저장 재활성(재시도 가능).
    expect(ta().value).toBe('수정됨');
    await waitFor(() => expect(saveBtn().disabled).toBe(false));
  });
});
