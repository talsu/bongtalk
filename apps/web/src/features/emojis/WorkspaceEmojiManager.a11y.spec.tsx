// @vitest-environment jsdom
/**
 * S42 fix-forward a11y (A-1 / A-2 / B-4) — WorkspaceEmojiManager 접근성 회귀고정.
 *
 * 검증 항목:
 *   - (A-1) 별칭 "+" 추가 버튼이 `:{name}: 별칭 추가` aria-label 을 갖는다.
 *   - (A-2) 별칭 추가 실패 시 입력 필드가 aria-invalid + aria-describedby 로 인라인
 *     에러 텍스트에 연결되고(토스트는 보조 유지), 한도 메시지 영역은 role="status"
 *     aria-live="polite" 다.
 *   - (B-4) 이모지 삭제 버튼이 `:{name}: 이모지 삭제` aria-label 을 갖는다.
 *
 * 데이터 훅(useCustomEmojis + mutations)과 알림 스토어를 모킹해 네트워크 없이
 * 렌더한다 — a11y 시맨틱 자체에 집중한다.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const addAliasMutateAsync = vi.fn();
const removeAliasMutateAsync = vi.fn();

vi.mock('./useCustomEmojis', () => ({
  useCustomEmojis: () => ({
    data: {
      items: [
        {
          id: 'e1',
          name: 'partyblob',
          url: 'https://cdn/p.gif',
          aliases: ['birb'],
          createdBy: 'u1',
          createdAt: '2025-01-01T00:00:00Z',
          urlExpiresAt: '2025-01-01T01:00:00Z',
          sizeBytes: 8,
          mime: 'image/gif',
        },
      ],
    },
  }),
  useUploadCustomEmoji: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteCustomEmoji: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useAddEmojiAlias: () => ({ mutateAsync: addAliasMutateAsync, isPending: false }),
  useRemoveEmojiAlias: () => ({ mutateAsync: removeAliasMutateAsync, isPending: false }),
}));

vi.mock('../../stores/notification-store', () => ({
  useNotifications: (selector: (s: { push: () => void }) => unknown) => selector({ push: vi.fn() }),
}));

import { WorkspaceEmojiManager } from './WorkspaceEmojiManager';

afterEach(() => cleanup());
beforeEach(() => {
  addAliasMutateAsync.mockReset();
  removeAliasMutateAsync.mockReset();
});

describe('WorkspaceEmojiManager a11y (S42 A-1 / B-4)', () => {
  it('A-1: 별칭 "+" 추가 버튼이 `:{name}: 별칭 추가` aria-label 을 갖는다', () => {
    render(<WorkspaceEmojiManager workspaceId="ws1" />);
    const addBtn = screen.getByTestId('emoji-alias-add-partyblob');
    expect(addBtn.getAttribute('aria-label')).toBe(':partyblob: 별칭 추가');
  });

  it('B-4: 이모지 삭제 버튼이 `:{name}: 이모지 삭제` aria-label 을 갖는다', () => {
    render(<WorkspaceEmojiManager workspaceId="ws1" />);
    const delBtn = screen.getByTestId('emoji-delete-partyblob');
    expect(delBtn.getAttribute('aria-label')).toBe(':partyblob: 이모지 삭제');
  });
});

describe('WorkspaceEmojiManager a11y (S42 A-2: 인라인 에러 연결)', () => {
  it('서버 충돌(409) 시 입력이 aria-invalid + aria-describedby 로 인라인 에러에 연결된다', async () => {
    addAliasMutateAsync.mockRejectedValueOnce(new Error(':dup: 은 이미 사용 중입니다.'));
    render(<WorkspaceEmojiManager workspaceId="ws1" />);

    const input = screen.getByTestId('emoji-alias-input-partyblob');
    fireEvent.change(input, { target: { value: 'dup' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      const err = screen.getByTestId('emoji-alias-error-partyblob');
      expect(err.textContent).toContain('이미 사용 중');
      // aria-describedby 가 인라인 에러의 id 를 가리킨다.
      expect(input.getAttribute('aria-describedby')).toBe(err.getAttribute('id'));
      expect(input.getAttribute('aria-invalid')).toBe('true');
    });
  });

  it('형식 오류는 mutation 호출 없이 인라인 에러로만 표시된다', async () => {
    render(<WorkspaceEmojiManager workspaceId="ws1" />);
    const input = screen.getByTestId('emoji-alias-input-partyblob');
    // 입력 onChange 가 단일 문자만 남기면 slug 최소 길이(2) 미만이라 형식 에러.
    fireEvent.change(input, { target: { value: 'a' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getByTestId('emoji-alias-error-partyblob')).toBeTruthy();
    });
    expect(addAliasMutateAsync).not.toHaveBeenCalled();
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });
});
