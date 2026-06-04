// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

/**
 * S65 (D13 / FR-W01): 워크스페이스 생성 모달의 joinMode 셀렉트 + 이메일 도메인
 * 화이트리스트 입력을 jsdom 으로 검증한다. 생성 mutation 과 라우팅을 모킹해 네트워크
 * 없이 폼 제출 payload 를 단언한다.
 */

const navigateSpy = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateSpy,
}));

const createMutate = vi.fn().mockResolvedValue({ slug: 'acme' });
vi.mock('./useWorkspaces', () => ({
  useCreateWorkspace: () => ({ mutateAsync: createMutate, isPending: false }),
}));

import { CreateWorkspaceDialog } from './CreateWorkspaceDialog';

function renderDialog(): void {
  render(<CreateWorkspaceDialog open onOpenChange={vi.fn()} />);
}

beforeEach(() => {
  createMutate.mockClear();
  navigateSpy.mockClear();
});

afterEach(() => cleanup());

describe('CreateWorkspaceDialog — joinMode + emailDomains (FR-W01)', () => {
  it('joinMode 셀렉트는 PRIVATE/PUBLIC/APPLY 세 옵션을 갖는다', () => {
    renderDialog();
    const select = screen.getByTestId('ws-join-mode') as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual(['PRIVATE', 'PUBLIC', 'APPLY']);
  });

  it('joinMode=APPLY + 이메일 도메인 텍스트를 정규화 배열로 제출한다', async () => {
    renderDialog();
    fireEvent.change(screen.getByTestId('ws-name'), { target: { value: 'Acme' } });
    fireEvent.change(screen.getByTestId('ws-slug'), { target: { value: 'acme-65' } });
    fireEvent.change(screen.getByTestId('ws-join-mode'), { target: { value: 'APPLY' } });
    fireEvent.change(screen.getByTestId('ws-email-domains'), {
      target: { value: 'Example.com, corp.io  example.com' },
    });
    fireEvent.click(screen.getByTestId('ws-create-submit'));

    await waitFor(() => expect(createMutate).toHaveBeenCalledTimes(1));
    const payload = createMutate.mock.calls[0][0] as {
      joinMode: string;
      emailDomains?: string[];
    };
    expect(payload.joinMode).toBe('APPLY');
    // 소문자화 + 중복 토큰은 분해되어 그대로 전달(서버가 dedupe), 빈 토큰 제거.
    expect(payload.emailDomains).toEqual(['example.com', 'corp.io', 'example.com']);
  });

  it('이메일 도메인을 비우면 emailDomains 키 없이 제출한다', async () => {
    renderDialog();
    fireEvent.change(screen.getByTestId('ws-name'), { target: { value: 'NoDomains' } });
    fireEvent.change(screen.getByTestId('ws-slug'), { target: { value: 'nodom-65' } });
    fireEvent.click(screen.getByTestId('ws-create-submit'));

    await waitFor(() => expect(createMutate).toHaveBeenCalledTimes(1));
    const payload = createMutate.mock.calls[0][0] as { emailDomains?: string[]; joinMode: string };
    expect(payload.emailDomains).toBeUndefined();
    expect(payload.joinMode).toBe('PRIVATE');
  });
});
