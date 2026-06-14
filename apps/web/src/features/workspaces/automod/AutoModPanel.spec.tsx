// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { AutoModRule } from '@qufox/shared-types';

/**
 * FR-RM10a (063) AutoModPanel RTL. Dialog/Button pass-through 모킹(portal 회피),
 * useWorkspaces hooks 모킹으로 목록·생성 모달·키워드 칩·삭제 호출을 검증한다.
 */
vi.mock('../../../design-system/primitives', () => ({
  Dialog: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
    open ? <div role="dialog">{children}</div> : null,
  Button: ({
    children,
    onClick,
    disabled,
    ...rest
  }: {
    children?: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    [k: string]: unknown;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled} {...rest}>
      {children}
    </button>
  ),
}));

const createMut = { mutate: vi.fn(), isPending: false };
const updateMut = { mutate: vi.fn(), isPending: false };
const deleteMut = { mutate: vi.fn(), isPending: false };
let rulesData: AutoModRule[] = [];

vi.mock('../useWorkspaces', () => ({
  useAutoModRules: () => ({ data: rulesData }),
  useCreateAutoModRule: () => createMut,
  useUpdateAutoModRule: () => updateMut,
  useDeleteAutoModRule: () => deleteMut,
}));

vi.mock('../../../stores/notification-store', () => ({
  useNotifications: () => vi.fn(),
}));

import { AutoModPanel } from './AutoModPanel';

function rule(over: Partial<AutoModRule>): AutoModRule {
  return {
    id: over.id ?? 'rule1',
    workspaceId: 'ws',
    name: over.name ?? 'block bad words',
    // 072 백로그 S-G: over.triggerType 을 honor(spam 룰 편집 테스트). 기본 KEYWORD.
    triggerType: over.triggerType ?? 'KEYWORD',
    keywords: over.keywords ?? ['spam'],
    matchMode: over.matchMode ?? 'SUBSTRING',
    action: over.action ?? 'BLOCK',
    timeoutSeconds: over.timeoutSeconds ?? null,
    // FR-RM10b: spam 트리거 파라미터(KEYWORD 룰은 null).
    mentionThreshold: over.mentionThreshold ?? null,
    repeatThreshold: over.repeatThreshold ?? null,
    windowSeconds: over.windowSeconds ?? null,
    exemptRoleIds: over.exemptRoleIds ?? [],
    exemptChannelIds: over.exemptChannelIds ?? [],
    enabled: over.enabled ?? true,
    createdBy: 'admin',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  };
}

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  rulesData = [];
  createMut.mutate.mockClear();
  updateMut.mutate.mockClear();
  deleteMut.mutate.mockClear();
});

afterEach(() => cleanup());

describe('AutoModPanel', () => {
  it('shows an empty state when there are no rules', () => {
    render(<AutoModPanel workspaceId="ws" canManage />);
    expect(screen.getByText('아직 규칙이 없습니다.')).toBeTruthy();
  });

  it('renders rules and hides management buttons when canManage is false', () => {
    rulesData = [rule({ id: 'r1', name: 'no swearing' })];
    render(<AutoModPanel workspaceId="ws" canManage={false} />);
    expect(screen.getByText('no swearing')).toBeTruthy();
    expect(screen.queryByTestId('automod-create')).toBeNull();
    expect(screen.queryByTestId('automod-delete-r1')).toBeNull();
  });

  it('opens the create dialog and submits a new rule with keyword chips', () => {
    render(<AutoModPanel workspaceId="ws" canManage />);
    fireEvent.click(screen.getByTestId('automod-create'));
    expect(screen.getByTestId('automod-form')).toBeTruthy();

    fireEvent.change(screen.getByTestId('automod-name'), { target: { value: 'my rule' } });
    const draft = screen.getByTestId('automod-keyword-draft');
    fireEvent.change(draft, { target: { value: 'Spam' } });
    fireEvent.keyDown(draft, { key: 'Enter' });

    fireEvent.click(screen.getByTestId('automod-submit'));
    expect(createMut.mutate).toHaveBeenCalledTimes(1);
    const body = createMut.mutate.mock.calls[0][0];
    // 키워드는 소문자 정규화되어 제출된다.
    expect(body.keywords).toEqual(['spam']);
    expect(body.name).toBe('my rule');
    expect(body.triggerType).toBe('KEYWORD');
  });

  it('shows the timeout field only when action is TIMEOUT', () => {
    render(<AutoModPanel workspaceId="ws" canManage />);
    fireEvent.click(screen.getByTestId('automod-create'));
    expect(screen.queryByTestId('automod-timeout')).toBeNull();
    fireEvent.change(screen.getByTestId('automod-action'), { target: { value: 'TIMEOUT' } });
    expect(screen.getByTestId('automod-timeout')).toBeTruthy();
  });

  it('deletes a rule when the delete button is clicked', () => {
    rulesData = [rule({ id: 'r9' })];
    render(<AutoModPanel workspaceId="ws" canManage />);
    fireEvent.click(screen.getByTestId('automod-delete-r9'));
    expect(deleteMut.mutate).toHaveBeenCalledWith('r9', expect.anything());
  });

  it('toggles enabled via the update mutation', () => {
    rulesData = [rule({ id: 'r3', enabled: true })];
    render(<AutoModPanel workspaceId="ws" canManage />);
    fireEvent.click(screen.getByTestId('automod-toggle-r3'));
    expect(updateMut.mutate).toHaveBeenCalledWith(
      { ruleId: 'r3', input: { enabled: false } },
      expect.anything(),
    );
  });

  // 072 백로그 S-G: 트리거 분기 — MENTION_SPAM 선택 시 키워드 대신 임계값/윈도 노출 +
  // discriminated-union body 조립.
  it('MENTION_SPAM 선택 시 키워드 필드 대신 임계값/윈도를 노출하고 spam body 를 제출한다', () => {
    render(<AutoModPanel workspaceId="ws" canManage />);
    fireEvent.click(screen.getByTestId('automod-create'));
    expect(screen.getByTestId('automod-keyword-draft')).toBeTruthy();
    expect(screen.queryByTestId('automod-spam-threshold')).toBeNull();

    fireEvent.change(screen.getByTestId('automod-trigger-type'), {
      target: { value: 'MENTION_SPAM' },
    });
    expect(screen.queryByTestId('automod-keyword-draft')).toBeNull();
    expect(screen.getByTestId('automod-spam-threshold')).toBeTruthy();
    expect(screen.getByTestId('automod-spam-window')).toBeTruthy();

    fireEvent.change(screen.getByTestId('automod-name'), { target: { value: '멘션 폭주' } });
    fireEvent.change(screen.getByTestId('automod-spam-threshold'), { target: { value: '10' } });
    fireEvent.change(screen.getByTestId('automod-spam-window'), { target: { value: '60' } });
    fireEvent.click(screen.getByTestId('automod-submit'));

    expect(createMut.mutate).toHaveBeenCalledTimes(1);
    const body = createMut.mutate.mock.calls[0][0];
    expect(body).toMatchObject({
      triggerType: 'MENTION_SPAM',
      name: '멘션 폭주',
      mentionThreshold: 10,
      windowSeconds: 60,
    });
    expect('keywords' in body).toBe(false);
  });

  it('수정 모드에서는 트리거 타입 select 가 비활성화된다(서버 미지원)', () => {
    rulesData = [
      rule({
        id: 'rs',
        triggerType: 'REPEAT_SPAM',
        repeatThreshold: 5,
        windowSeconds: 30,
        keywords: [],
      }),
    ];
    render(<AutoModPanel workspaceId="ws" canManage />);
    fireEvent.click(screen.getByTestId('automod-edit-rs'));
    const select = screen.getByTestId('automod-trigger-type') as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(screen.getByTestId('automod-spam-threshold')).toBeTruthy();
    expect(screen.getByTestId('automod-spam-window')).toBeTruthy();
  });
});
