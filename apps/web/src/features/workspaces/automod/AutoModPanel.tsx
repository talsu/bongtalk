import { useState } from 'react';
import type {
  AutoModAction,
  AutoModMatch,
  AutoModRule,
  CreateAutoModRuleRequest,
} from '@qufox/shared-types';
import {
  AUTOMOD_ACTION_LABELS,
  AUTOMOD_KEYWORDS_MAX,
  AUTOMOD_MATCH_LABELS,
  AUTOMOD_RULE_NAME_MAX,
  AUTOMOD_TIMEOUT_MIN_SECONDS,
} from '@qufox/shared-types';
import { Dialog, Button } from '../../../design-system/primitives';
import { useNotifications } from '../../../stores/notification-store';
import {
  useAutoModRules,
  useCreateAutoModRule,
  useUpdateAutoModRule,
  useDeleteAutoModRule,
} from '../useWorkspaces';

/**
 * FR-RM10a (063 / ADR E5): 워크스페이스 AutoMod 키워드 규칙 관리 패널.
 *
 * ADMIN+ 가 키워드 규칙(이름·키워드 칩·매칭 모드·액션·TIMEOUT 시 기간·enabled 토글)을
 * 생성/수정/삭제한다. 서버 게이트(@Roles ADMIN)가 최종 권위이며, 이 패널은 canManage 가
 * false 면 읽기 전용으로 렌더한다. DS qf-* + Tailwind 토큰만 사용(raw hex/px 금지).
 */
export function AutoModPanel({
  workspaceId,
  canManage,
}: {
  workspaceId: string;
  canManage: boolean;
}): JSX.Element {
  const { data: rules } = useAutoModRules(workspaceId);
  const del = useDeleteAutoModRule(workspaceId);
  const update = useUpdateAutoModRule(workspaceId);
  const notify = useNotifications((s) => s.push);
  const [editing, setEditing] = useState<AutoModRule | null>(null);
  const [creating, setCreating] = useState(false);

  const onDelete = (rule: AutoModRule): void => {
    del.mutate(rule.id, {
      onSuccess: () => notify({ variant: 'success', title: '규칙을 삭제했습니다.' }),
      onError: () => notify({ variant: 'danger', title: '규칙 삭제에 실패했습니다.' }),
    });
  };

  const onToggle = (rule: AutoModRule): void => {
    update.mutate(
      { ruleId: rule.id, input: { enabled: !rule.enabled } },
      {
        onError: () => notify({ variant: 'danger', title: '규칙 상태 변경에 실패했습니다.' }),
      },
    );
  };

  return (
    <div className="flex flex-col gap-[var(--s-4)]" data-testid="automod-panel">
      <div className="flex items-center justify-between">
        <p className="text-[length:var(--fs-13)] text-text-muted">
          키워드가 포함된 메시지를 자동으로 차단·경고하거나 작성자를 타임아웃합니다.
        </p>
        {canManage && (
          <Button variant="primary" onClick={() => setCreating(true)} data-testid="automod-create">
            규칙 추가
          </Button>
        )}
      </div>

      {(rules?.length ?? 0) === 0 ? (
        <p className="py-[var(--s-4)] text-[length:var(--fs-13)] text-text-muted">
          아직 규칙이 없습니다.
        </p>
      ) : (
        <ul className="flex flex-col gap-[var(--s-2)]" aria-label="AutoMod 규칙 목록">
          {rules!.map((rule) => (
            <li
              key={rule.id}
              className="flex items-center justify-between gap-[var(--s-3)] rounded-[var(--r-md)] bg-bg-subtle px-[var(--s-3)] py-[var(--s-2)]"
              data-testid={`automod-rule-${rule.id}`}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-[var(--s-2)]">
                  <span className="truncate text-[length:var(--fs-14)] text-foreground">
                    {rule.name}
                  </span>
                  <span className="shrink-0 rounded-[var(--r-sm)] bg-bg-muted px-[var(--s-2)] text-[length:var(--fs-12)] text-text-muted">
                    {AUTOMOD_ACTION_LABELS[rule.action]}
                  </span>
                  {!rule.enabled && (
                    <span className="shrink-0 text-[length:var(--fs-12)] text-text-muted">
                      (비활성)
                    </span>
                  )}
                </div>
                <p className="truncate text-[length:var(--fs-12)] text-text-muted">
                  {AUTOMOD_MATCH_LABELS[rule.matchMode]} · {rule.keywords.length}개 키워드
                </p>
              </div>
              {canManage && (
                <div className="flex shrink-0 items-center gap-[var(--s-2)]">
                  <Button
                    variant="ghost"
                    onClick={() => onToggle(rule)}
                    data-testid={`automod-toggle-${rule.id}`}
                  >
                    {rule.enabled ? '끄기' : '켜기'}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => setEditing(rule)}
                    data-testid={`automod-edit-${rule.id}`}
                  >
                    수정
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() => onDelete(rule)}
                    data-testid={`automod-delete-${rule.id}`}
                  >
                    삭제
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {(creating || editing) && (
        <RuleFormDialog
          workspaceId={workspaceId}
          rule={editing}
          open
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

/** 규칙 생성/수정 다이얼로그. rule 이 있으면 수정, 없으면 생성. */
function RuleFormDialog({
  workspaceId,
  rule,
  open,
  onClose,
}: {
  workspaceId: string;
  rule: AutoModRule | null;
  open: boolean;
  onClose: () => void;
}): JSX.Element {
  const create = useCreateAutoModRule(workspaceId);
  const update = useUpdateAutoModRule(workspaceId);
  const notify = useNotifications((s) => s.push);

  const [name, setName] = useState(rule?.name ?? '');
  const [keywords, setKeywords] = useState<string[]>(rule?.keywords ?? []);
  const [draft, setDraft] = useState('');
  const [matchMode, setMatchMode] = useState<AutoModMatch>(rule?.matchMode ?? 'SUBSTRING');
  const [action, setAction] = useState<AutoModAction>(rule?.action ?? 'BLOCK');
  const [timeoutSeconds, setTimeoutSeconds] = useState<number>(rule?.timeoutSeconds ?? 300);

  const addKeyword = (): void => {
    const t = draft.trim().toLowerCase();
    if (t.length === 0) return;
    if (keywords.includes(t)) {
      setDraft('');
      return;
    }
    if (keywords.length >= AUTOMOD_KEYWORDS_MAX) {
      notify({
        variant: 'danger',
        title: `키워드는 최대 ${AUTOMOD_KEYWORDS_MAX}개까지 등록할 수 있습니다.`,
      });
      return;
    }
    setKeywords([...keywords, t]);
    setDraft('');
  };

  const canSubmit =
    name.trim().length > 0 && name.trim().length <= AUTOMOD_RULE_NAME_MAX && keywords.length > 0;

  const onSubmit = (): void => {
    if (!canSubmit) return;
    if (rule) {
      update.mutate(
        {
          ruleId: rule.id,
          input: {
            name: name.trim(),
            keywords,
            matchMode,
            action,
            timeoutSeconds: action === 'TIMEOUT' ? timeoutSeconds : null,
          },
        },
        {
          onSuccess: () => {
            notify({ variant: 'success', title: '규칙을 저장했습니다.' });
            onClose();
          },
          onError: () => notify({ variant: 'danger', title: '규칙 저장에 실패했습니다.' }),
        },
      );
      return;
    }
    const body: CreateAutoModRuleRequest = {
      name: name.trim(),
      triggerType: 'KEYWORD',
      keywords,
      matchMode,
      action,
      ...(action === 'TIMEOUT' ? { timeoutSeconds } : {}),
    };
    create.mutate(body, {
      onSuccess: () => {
        notify({ variant: 'success', title: '규칙을 추가했습니다.' });
        onClose();
      },
      onError: () => notify({ variant: 'danger', title: '규칙 추가에 실패했습니다.' }),
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
      title={rule ? 'AutoMod 규칙 수정' : 'AutoMod 규칙 추가'}
      description="키워드가 포함된 메시지에 적용할 모더레이션 규칙을 설정합니다."
    >
      <div className="flex flex-col gap-[var(--s-4)]" data-testid="automod-form">
        <label className="flex flex-col gap-[var(--s-2)]">
          <span className="text-[length:var(--fs-13)] text-text-muted">규칙 이름</span>
          <input
            type="text"
            className="qf-input w-full"
            value={name}
            maxLength={AUTOMOD_RULE_NAME_MAX}
            onChange={(e) => setName(e.target.value)}
            data-testid="automod-name"
            aria-label="규칙 이름"
          />
        </label>

        <div className="flex flex-col gap-[var(--s-2)]">
          <span className="text-[length:var(--fs-13)] text-text-muted">키워드</span>
          {keywords.length > 0 && (
            <ul
              className="flex flex-wrap gap-[var(--s-2)]"
              aria-label={`키워드 ${keywords.length}개`}
            >
              {keywords.map((kw) => (
                <li
                  key={kw}
                  className="inline-flex items-center gap-[var(--s-2)] rounded-[var(--r-md)] bg-bg-subtle px-[var(--s-3)] py-[var(--s-1)] text-[length:var(--fs-12)] text-foreground"
                >
                  <span>{kw}</span>
                  <button
                    type="button"
                    className="qf-btn qf-btn--ghost qf-btn--icon qf-btn--sm"
                    aria-label={`키워드 "${kw}" 삭제`}
                    onClick={() => setKeywords(keywords.filter((k) => k !== kw))}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <input
            type="text"
            className="qf-input w-full"
            value={draft}
            placeholder="키워드 입력 후 Enter"
            data-testid="automod-keyword-draft"
            aria-label="키워드 추가"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                addKeyword();
              }
            }}
          />
        </div>

        <label className="flex flex-col gap-[var(--s-2)]">
          <span className="text-[length:var(--fs-13)] text-text-muted">매칭 모드</span>
          <select
            className="qf-input w-full"
            value={matchMode}
            onChange={(e) => setMatchMode(e.target.value as AutoModMatch)}
            data-testid="automod-match-mode"
            aria-label="매칭 모드"
          >
            {(Object.keys(AUTOMOD_MATCH_LABELS) as AutoModMatch[]).map((m) => (
              <option key={m} value={m}>
                {AUTOMOD_MATCH_LABELS[m]}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-[var(--s-2)]">
          <span className="text-[length:var(--fs-13)] text-text-muted">액션</span>
          <select
            className="qf-input w-full"
            value={action}
            onChange={(e) => setAction(e.target.value as AutoModAction)}
            data-testid="automod-action"
            aria-label="액션"
          >
            {(Object.keys(AUTOMOD_ACTION_LABELS) as AutoModAction[]).map((a) => (
              <option key={a} value={a}>
                {AUTOMOD_ACTION_LABELS[a]}
              </option>
            ))}
          </select>
        </label>

        {action === 'TIMEOUT' && (
          <label className="flex flex-col gap-[var(--s-2)]">
            <span className="text-[length:var(--fs-13)] text-text-muted">타임아웃(초)</span>
            <input
              type="number"
              className="qf-input w-full"
              min={AUTOMOD_TIMEOUT_MIN_SECONDS}
              value={timeoutSeconds}
              onChange={(e) => setTimeoutSeconds(Number(e.target.value))}
              data-testid="automod-timeout"
              aria-label="타임아웃 초"
            />
          </label>
        )}

        <div className="flex justify-end gap-[var(--s-2)]">
          <Button variant="ghost" onClick={onClose} data-testid="automod-cancel">
            취소
          </Button>
          <Button
            variant="primary"
            disabled={!canSubmit || create.isPending || update.isPending}
            onClick={onSubmit}
            data-testid="automod-submit"
          >
            저장
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
