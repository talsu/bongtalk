// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { ListEditHistoryResponse } from '@qufox/shared-types';

/**
 * S37 (FR-MSG-08) + fix-forward a11y: 편집 이력 팝오버의 본문 렌더 상태(로딩/
 * 에러403/빈/목록)와 AST·평문 폴백, a11y(트리거 focus-visible 링 + 수동
 * aria-haspopup 미부여 / content role=region + tabIndex=-1 / 로딩 role=status /
 * 항목 <time> aria-label)를 검증한다.
 *
 * Radix Popover 는 jsdom 의 pointer-capture / portal 거동이 까다로워, 이
 * 테스트는 popover primitive 를 항상 content 를 렌더하는 pass-through 로 모킹해
 * 본문 분기 로직 자체에 집중한다(트리거/콘텐츠 시맨틱은 정적으로 검증 가능).
 * 데이터 훅(useEditHistory)과 커스텀 이모지 컨텍스트를 모킹해 네트워크 없이
 * 렌더한다.
 */

// ── Radix Popover pass-through (항상 children 렌더, 시맨틱 속성 보존) ──────────
vi.mock('@radix-ui/react-popover', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  const Trigger = ({
    children,
    asChild: _asChild,
  }: {
    children?: ReactNode;
    asChild?: boolean;
  }) => <>{children}</>;
  const Content = ({
    children,
    className,
    role,
    tabIndex,
    'aria-label': ariaLabel,
    'data-testid': testId,
  }: {
    children?: ReactNode;
    className?: string;
    role?: string;
    tabIndex?: number;
    'aria-label'?: string;
    'data-testid'?: string;
  }) => (
    <div
      className={className}
      role={role}
      tabIndex={tabIndex}
      aria-label={ariaLabel}
      data-testid={testId}
    >
      {children}
    </div>
  );
  return { Root: Pass, Trigger, Portal: Pass, Content };
});

// ── useEditHistory 모킹 — 케이스별로 반환값을 바꾼다 ──────────────────────────
let historyState: {
  isLoading: boolean;
  isError: boolean;
  error?: unknown;
  data?: ListEditHistoryResponse;
};
vi.mock('./useMessages', () => ({
  useEditHistory: () => historyState,
}));

vi.mock('../emojis/CustomEmojiContext', () => ({
  useCustomEmojiLookup: () => ({ byName: new Map(), list: [] }),
}));

import { EditHistoryPopover } from './EditHistoryPopover';

const baseProps = {
  workspaceId: 'ws-1',
  channelId: 'ch-1',
  msgId: 'msg-1',
  editedAt: '2025-01-01T00:00:00.000Z',
};

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T12:00:00Z'));
  historyState = { isLoading: false, isError: false, data: { items: [] } };
});
afterEach(() => cleanup());

describe('EditHistoryPopover (FR-MSG-08)', () => {
  it('트리거는 (수정됨) 라벨 + aria-label 을 가지고, 수동 aria-haspopup 은 부여하지 않는다(N-1)', () => {
    render(<EditHistoryPopover {...baseProps} />);
    const trigger = screen.getByTestId('msg-edited-msg-1');
    expect(trigger.textContent).toContain('(수정됨)');
    expect(trigger.getAttribute('aria-label')).toBe('편집 이력 보기');
    // N-1: aria-haspopup 은 Radix Trigger 가 자동 주입하므로 컴포넌트가 직접 부여
    // 하지 않는다(중복 방지). pass-through 모킹에서는 속성이 비어 있어야 한다.
    expect(trigger.getAttribute('aria-haspopup')).toBeNull();
    // B-3: focus-visible 링을 DS --ring-focus 토큰으로 명시.
    expect(trigger.className).toContain('focus-visible:shadow-[var(--ring-focus)]');
  });

  it('content 는 role=region + tabIndex=-1 + aria-label 편집 이력 을 부여한다(a11y B-1/B-2)', () => {
    render(<EditHistoryPopover {...baseProps} />);
    const region = screen.getByTestId('edit-history-popover-msg-1');
    // B-2: 비모달 맥락 정보 팝오버 → role="region"(role="dialog" 아님).
    expect(region.getAttribute('role')).toBe('region');
    expect(region.getAttribute('aria-label')).toBe('편집 이력');
    // B-1: 포커스 앵커.
    expect(region.getAttribute('tabindex')).toBe('-1');
  });

  it('로딩 중에는 role=status 로 불러오는 중 표시(M-2)', () => {
    historyState = { isLoading: true, isError: false };
    render(<EditHistoryPopover {...baseProps} />);
    const loading = screen.getByTestId('edit-history-loading');
    expect(loading).toBeTruthy();
    expect(loading.getAttribute('role')).toBe('status');
  });

  it('403(MESSAGE_NOT_AUTHOR) 은 권한 없음 안내를 친절히 표시한다', () => {
    historyState = {
      isLoading: false,
      isError: true,
      error: { errorCode: 'MESSAGE_NOT_AUTHOR' },
    };
    render(<EditHistoryPopover {...baseProps} />);
    const err = screen.getByTestId('edit-history-error');
    expect(err.textContent).toContain('권한이 없습니다');
    expect(err.getAttribute('role')).toBe('alert');
  });

  it('기타 에러는 일반 실패 안내를 표시한다', () => {
    historyState = { isLoading: false, isError: true, error: { errorCode: 'INTERNAL' } };
    render(<EditHistoryPopover {...baseProps} />);
    expect(screen.getByTestId('edit-history-error').textContent).toContain('불러오지 못했습니다');
  });

  it('빈 이력은 안내 문구를 표시한다', () => {
    historyState = { isLoading: false, isError: false, data: { items: [] } };
    render(<EditHistoryPopover {...baseProps} />);
    expect(screen.getByTestId('edit-history-empty')).toBeTruthy();
  });

  it('버전 목록을 desc 순으로 렌더하고 최상단에 직전 본문 뱃지를 단다', () => {
    historyState = {
      isLoading: false,
      isError: false,
      data: {
        items: [
          {
            version: 2,
            contentRaw: 'second',
            contentAst: null,
            contentPlain: 'second edit',
            editedAt: '2025-01-01T11:00:00.000Z',
          },
          {
            version: 1,
            contentRaw: 'first',
            contentAst: null,
            contentPlain: 'first body',
            editedAt: '2025-01-01T10:00:00.000Z',
          },
        ],
      },
    };
    render(<EditHistoryPopover {...baseProps} />);
    const list = screen.getByTestId('edit-history-list');
    expect(list).toBeTruthy();
    // contentAst 가 null 인 항목은 contentPlain 평문으로 렌더.
    expect(list.textContent).toContain('second edit');
    expect(list.textContent).toContain('first body');
    // 최상단(최신=직전 본문) 항목에만 '직전 본문' 뱃지.
    const badges = list.querySelectorAll('.qf-badge--accent');
    expect(badges.length).toBe(1);
    expect(badges[0].textContent).toContain('직전 본문');
    // a11y M-3: 각 항목의 <time> 에 절대 시각 aria-label 을 부여한다(SR 모호성 제거).
    const times = list.querySelectorAll('time[aria-label]');
    expect(times.length).toBe(2);
    for (const t of Array.from(times)) {
      expect(t.getAttribute('aria-label')).toBeTruthy();
    }
  });

  it('contentAst 가 있으면 AST 렌더 경로를 쓴다(평문 대신 AST 텍스트)', () => {
    historyState = {
      isLoading: false,
      isError: false,
      data: {
        items: [
          {
            version: 1,
            contentRaw: 'hi',
            contentAst: {
              type: 'rich_text',
              nodes: [{ type: 'paragraph', nodes: [{ type: 'text', text: 'rendered ast' }] }],
            } as unknown as ListEditHistoryResponse['items'][number]['contentAst'],
            contentPlain: 'plain ignored',
            editedAt: '2025-01-01T10:00:00.000Z',
          },
        ],
      },
    };
    render(<EditHistoryPopover {...baseProps} />);
    const list = screen.getByTestId('edit-history-list');
    expect(list.textContent).toContain('rendered ast');
  });
});
