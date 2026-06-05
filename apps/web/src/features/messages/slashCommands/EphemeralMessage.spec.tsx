// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { EphemeralMessage } from './EphemeralMessage';
import type { EphemeralMessage as EphemeralMessageData } from './useEphemeralMessages';

afterEach(() => cleanup());

/**
 * S80 (D15 / FR-SC-05) — EPHEMERAL 인라인 메시지 컴포넌트 테스트.
 */
function make(over: Partial<EphemeralMessageData> = {}): EphemeralMessageData {
  return {
    id: 'eph-1',
    channelId: 'c1',
    content: '상태를 자리 비움으로 바꿨습니다',
    error: false,
    createdAt: 0,
    ...over,
  };
}

describe('EphemeralMessage', () => {
  it('content 와 "나만 보임" 라벨을 렌더한다', () => {
    render(<EphemeralMessage msg={make()} onDismiss={() => {}} />);
    expect(screen.getByText('상태를 자리 비움으로 바꿨습니다')).toBeTruthy();
    expect(screen.getByText('나만 보임')).toBeTruthy();
  });

  it('a11y(S80 fix): per-item 은 라이브 영역이 아니다(SR 통지는 공유 announcer 가 담당)', () => {
    // 마운트와 동시에 채워지는 노드의 aria-live 는 SR 이 감지하지 못하고 announcer 와
    // 겹치면 이중 낭독이 되므로, 행에는 role=status/aria-live 를 두지 않는다.
    render(<EphemeralMessage msg={make()} onDismiss={() => {}} />);
    const el = screen.getByTestId('ephemeral-eph-1');
    expect(el.getAttribute('role')).toBeNull();
    expect(el.getAttribute('aria-live')).toBeNull();
  });

  it('a11y: 닫기 버튼은 aria-label 로 의미를 노출한다', () => {
    render(<EphemeralMessage msg={make()} onDismiss={() => {}} />);
    expect(screen.getByTestId('ephemeral-dismiss-eph-1').getAttribute('aria-label')).toBe(
      '알림 닫기',
    );
  });

  it('error 면 data-error=true 로 표시한다', () => {
    render(
      <EphemeralMessage
        msg={make({ error: true, content: '시각 이해 불가' })}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByTestId('ephemeral-eph-1').getAttribute('data-error')).toBe('true');
  });

  it('닫기 버튼 클릭 시 onDismiss 를 호출한다', () => {
    const onDismiss = vi.fn();
    render(<EphemeralMessage msg={make()} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByTestId('ephemeral-dismiss-eph-1'));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('재전송/공유 같은 메시지 액션은 노출하지 않는다(닫기만)', () => {
    render(<EphemeralMessage msg={make()} onDismiss={() => {}} />);
    expect(screen.queryByText('다시 시도')).toBeNull();
    expect(screen.queryByText('공유')).toBeNull();
  });
});
