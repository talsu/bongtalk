// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { InviteExpired } from './InviteExpired';

/**
 * S66 (D13 / FR-W21): 만료·비활성·횟수초과 초대 전용 화면. 카피·홈 이동 버튼·선택적
 * 워크스페이스명 표기를 검증한다.
 */
afterEach(() => cleanup());

describe('InviteExpired (FR-W21)', () => {
  it('PRD 카피와 홈 이동 버튼을 렌더한다', () => {
    render(
      <MemoryRouter>
        <InviteExpired />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('invite-expired')).toBeTruthy();
    expect(
      screen.getByText(
        '초대 링크가 만료되었거나 유효하지 않습니다. 워크스페이스 관리자에게 새 링크를 요청하세요.',
      ),
    ).toBeTruthy();
    const home = screen.getByTestId('invite-expired-home') as HTMLAnchorElement;
    expect(home.getAttribute('href')).toBe('/');
  });

  it('workspaceName 이 주어지면 함께 표기한다', () => {
    render(
      <MemoryRouter>
        <InviteExpired workspaceName="Acme Corp" />
      </MemoryRouter>,
    );
    expect(screen.getByText('Acme Corp')).toBeTruthy();
  });
});
