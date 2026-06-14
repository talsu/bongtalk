import { useState } from 'react';
import type {
  AutoModAction,
  AutoModMatch,
  AutoModRule,
  AutoModTrigger,
  CreateAutoModRuleRequest,
} from '@qufox/shared-types';
import {
  AUTOMOD_ACTION_LABELS,
  AUTOMOD_KEYWORDS_MAX,
  AUTOMOD_MATCH_LABELS,
  AUTOMOD_RULE_NAME_MAX,
  AUTOMOD_TIMEOUT_MIN_SECONDS,
  // 072 백로그 S-G: spam 트리거 폼 분기용 라벨/범위.
  AUTOMOD_TRIGGER_LABELS,
  AUTOMOD_SPAM_THRESHOLD_MIN,
  AUTOMOD_SPAM_THRESHOLD_MAX,
  AUTOMOD_SPAM_WINDOW_MIN_SECONDS,
  AUTOMOD_SPAM_WINDOW_MAX_SECONDS,
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
                  {/* 072 백로그 S-G: 트리거별 요약 — KEYWORD 는 매칭 모드·키워드 수,
                      spam 은 임계값·윈도를 보여준다. */}
                  {AUTOMOD_TRIGGER_LABELS[rule.triggerType]}
                  {rule.triggerType === 'KEYWORD'
                    ? ` · ${AUTOMOD_MATCH_LABELS[rule.matchMode]} · ${rule.keywords.length}개 키워드`
                    : rule.triggerType === 'MENTION_SPAM'
                      ? ` · ${rule.mentionThreshold ?? '?'}회 멘션 / ${rule.windowSeconds ?? '?'}초`
                      : ` · ${rule.repeatThreshold ?? '?'}회 반복 / ${rule.windowSeconds ?? '?'}초`}
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

  // 072 백로그 S-G: 트리거 타입 분기. 생성 시 선택 가능, 수정 시 고정(서버가 triggerType
  // 변경 미지원). spam 2종은 임계값 + 윈도(초), KEYWORD 는 키워드 칩 + 매칭 모드.
  const [triggerType, setTriggerType] = useState<AutoModTrigger>(rule?.triggerType ?? 'KEYWORD');
  const [name, setName] = useState(rule?.name ?? '');
  const [keywords, setKeywords] = useState<string[]>(rule?.keywords ?? []);
  const [draft, setDraft] = useState('');
  const [matchMode, setMatchMode] = useState<AutoModMatch>(rule?.matchMode ?? 'SUBSTRING');
  const [action, setAction] = useState<AutoModAction>(rule?.action ?? 'BLOCK');
  const [timeoutSeconds, setTimeoutSeconds] = useState<number>(rule?.timeoutSeconds ?? 300);
  // spam 파라미터. KEYWORD 룰 편집 시엔 null → 기본값으로 초기화(전환 불가라 미사용).
  const [mentionThreshold, setMentionThreshold] = useState<number>(rule?.mentionThreshold ?? 5);
  const [repeatThreshold, setRepeatThreshold] = useState<number>(rule?.repeatThreshold ?? 5);
  const [windowSeconds, setWindowSeconds] = useState<number>(rule?.windowSeconds ?? 30);

  const isKeyword = triggerType === 'KEYWORD';
  const isMentionSpam = triggerType === 'MENTION_SPAM';
  const isSpam = !isKeyword;
  const spamThreshold = isMentionSpam ? mentionThreshold : repeatThreshold;
  const setSpamThreshold = isMentionSpam ? setMentionThreshold : setRepeatThreshold;

  const addKeyword = (): void => {
    // 072 S-G 리뷰(MEDIUM): REGEX 패턴은 대소문자가 의미를 가지므로 소문자화하지 않는다
    // (서버 normalizeRegexPatterns 가 원문 보존 — 리터럴만 소문자화). 종전 무조건 소문자화는
    // `[A-Z]{4,}` 같은 대소문자 의존 정규식을 침묵 변형했다.
    const t = matchMode === 'REGEX' ? draft.trim() : draft.trim().toLowerCase();
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

  const nameValid = name.trim().length > 0 && name.trim().length <= AUTOMOD_RULE_NAME_MAX;
  // 트리거별 필수 입력: KEYWORD=키워드 1개+, spam=임계값/윈도가 허용 범위.
  const spamValid =
    // 072 S-G 리뷰(LOW): 서버 스키마가 .int() 이므로 소수 입력을 FE 에서 미리 막는다
    // (range 만 검사하면 5.5 가 통과 후 서버 400 → 불명확 토스트).
    Number.isInteger(spamThreshold) &&
    Number.isInteger(windowSeconds) &&
    spamThreshold >= AUTOMOD_SPAM_THRESHOLD_MIN &&
    spamThreshold <= AUTOMOD_SPAM_THRESHOLD_MAX &&
    windowSeconds >= AUTOMOD_SPAM_WINDOW_MIN_SECONDS &&
    windowSeconds <= AUTOMOD_SPAM_WINDOW_MAX_SECONDS;
  const canSubmit = nameValid && (isKeyword ? keywords.length > 0 : spamValid);

  const onSubmit = (): void => {
    if (!canSubmit) return;
    const timeoutField = action === 'TIMEOUT' ? { timeoutSeconds } : {};
    if (rule) {
      // 수정: 룰의 고정 triggerType 에 맞는 필드만 전송(서버가 무관 필드 무시).
      const input = {
        name: name.trim(),
        action,
        timeoutSeconds: action === 'TIMEOUT' ? timeoutSeconds : null,
        ...(rule.triggerType === 'KEYWORD'
          ? { keywords, matchMode }
          : rule.triggerType === 'MENTION_SPAM'
            ? { mentionThreshold, windowSeconds }
            : { repeatThreshold, windowSeconds }),
      };
      update.mutate(
        { ruleId: rule.id, input },
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
    // 생성: discriminated union — triggerType 별 body 조립.
    let body: CreateAutoModRuleRequest;
    if (isKeyword) {
      body = {
        name: name.trim(),
        triggerType: 'KEYWORD',
        keywords,
        matchMode,
        action,
        ...timeoutField,
      };
    } else if (isMentionSpam) {
      body = {
        name: name.trim(),
        triggerType: 'MENTION_SPAM',
        mentionThreshold,
        windowSeconds,
        action,
        ...timeoutField,
      };
    } else {
      body = {
        name: name.trim(),
        triggerType: 'REPEAT_SPAM',
        repeatThreshold,
        windowSeconds,
        action,
        ...timeoutField,
      };
    }
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

        {/* 072 백로그 S-G: 트리거 타입. 생성 시 선택, 수정 시 고정(서버 미지원). */}
        <label className="flex flex-col gap-[var(--s-2)]">
          <span className="text-[length:var(--fs-13)] text-text-muted">트리거</span>
          <select
            aria-label="트리거 타입"
            className="qf-input w-full"
            value={triggerType}
            disabled={!!rule}
            onChange={(e) => setTriggerType(e.target.value as AutoModTrigger)}
            data-testid="automod-trigger-type"
          >
            {(Object.keys(AUTOMOD_TRIGGER_LABELS) as AutoModTrigger[]).map((t) => (
              <option key={t} value={t}>
                {AUTOMOD_TRIGGER_LABELS[t]}
              </option>
            ))}
          </select>
        </label>

        {isKeyword && (
          <>
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
                aria-label="매칭 모드"
                className="qf-input w-full"
                value={matchMode}
                onChange={(e) => setMatchMode(e.target.value as AutoModMatch)}
                data-testid="automod-match-mode"
              >
                {(Object.keys(AUTOMOD_MATCH_LABELS) as AutoModMatch[]).map((m) => (
                  <option key={m} value={m}>
                    {AUTOMOD_MATCH_LABELS[m]}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}

        {isSpam && (
          <>
            <label className="flex flex-col gap-[var(--s-2)]">
              <span className="text-[length:var(--fs-13)] text-text-muted">
                {isMentionSpam ? '멘션 임계값(회)' : '반복 임계값(회)'}
              </span>
              <input
                type="number"
                // a11y(input-label-guard): aria-label 을 onChange(=> 포함) 보다 앞에 둬
                // 가드의 attr 스캔(>에서 절단)이 인식하게 한다.
                aria-label={isMentionSpam ? '멘션 임계값' : '반복 임계값'}
                className="qf-input w-full"
                step={1}
                min={AUTOMOD_SPAM_THRESHOLD_MIN}
                max={AUTOMOD_SPAM_THRESHOLD_MAX}
                value={spamThreshold}
                onChange={(e) => setSpamThreshold(Number(e.target.value))}
                data-testid="automod-spam-threshold"
              />
            </label>
            <label className="flex flex-col gap-[var(--s-2)]">
              <span className="text-[length:var(--fs-13)] text-text-muted">윈도(초)</span>
              <input
                type="number"
                aria-label="윈도 초"
                className="qf-input w-full"
                step={1}
                min={AUTOMOD_SPAM_WINDOW_MIN_SECONDS}
                max={AUTOMOD_SPAM_WINDOW_MAX_SECONDS}
                value={windowSeconds}
                onChange={(e) => setWindowSeconds(Number(e.target.value))}
                data-testid="automod-spam-window"
              />
            </label>
          </>
        )}

        <label className="flex flex-col gap-[var(--s-2)]">
          <span className="text-[length:var(--fs-13)] text-text-muted">액션</span>
          <select
            aria-label="액션"
            className="qf-input w-full"
            value={action}
            onChange={(e) => setAction(e.target.value as AutoModAction)}
            data-testid="automod-action"
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
              aria-label="타임아웃 초"
              className="qf-input w-full"
              min={AUTOMOD_TIMEOUT_MIN_SECONDS}
              value={timeoutSeconds}
              onChange={(e) => setTimeoutSeconds(Number(e.target.value))}
              data-testid="automod-timeout"
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
