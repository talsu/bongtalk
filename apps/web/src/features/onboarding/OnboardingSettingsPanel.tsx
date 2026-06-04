import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  RULE_TITLE_MAX,
  RULE_DESCRIPTION_MAX,
  WELCOME_MESSAGE_MAX,
  WORKSPACE_RULES_MAX,
  type QuestionType,
  type OnboardingQuestion,
  type WorkspaceRule,
} from '@qufox/shared-types';
import { Button, Dialog, Input } from '../../design-system/primitives';
import {
  createQuestion,
  createRule,
  deleteQuestion,
  deleteRule,
  listQuestions,
  listRules,
  getWelcome,
  upsertWelcome,
} from './api';

/**
 * S71 (D13 / FR-W07·W08·W09 · 결정 5): 관리자(ADMIN+) 온보딩 설정 패널 — 규칙/질문/웰컴 CRUD.
 * 워크스페이스 설정 페이지의 '온보딩' 탭에 마운트된다. 온보딩이 빈 상태면 신규 멤버가 거칠
 * 단계가 없으므로(자동 완료), 이 패널이 카탈로그를 채우는 단일 진입점이다.
 */
export function OnboardingSettingsPanel({ slug }: { slug: string }): JSX.Element {
  return (
    <div className="flex flex-col gap-[var(--s-6)]" data-testid="onboarding-settings">
      <RulesSection slug={slug} />
      <div className="border-t border-border-subtle pt-[var(--s-5)]">
        <QuestionsSection slug={slug} />
      </div>
      <div className="border-t border-border-subtle pt-[var(--s-5)]">
        <WelcomeSection slug={slug} />
      </div>
    </div>
  );
}

function RulesSection({ slug }: { slug: string }): JSX.Element {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['onboarding', 'admin', 'rules', slug],
    queryFn: () => listRules(slug),
  });
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  // a11y MAJOR-3: 삭제 확인 대상(되돌릴 수 없는 파괴적 액션 — alertDialog).
  const [confirmDelete, setConfirmDelete] = useState<WorkspaceRule | null>(null);
  const invalidate = () =>
    void qc.invalidateQueries({ queryKey: ['onboarding', 'admin', 'rules', slug] });
  const create = useMutation({
    mutationFn: () => createRule(slug, { title, description: description || null }),
    onSuccess: () => {
      setTitle('');
      setDescription('');
      invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteRule(slug, id),
    onSuccess: invalidate,
  });
  const rules = data?.rules ?? [];

  return (
    <section className="flex flex-col gap-[var(--s-3)]" data-testid="onboarding-rules-section">
      <h3 className="text-text-strong font-semibold text-[length:var(--fs-15)]">규칙 (FR-W07)</h3>
      <p className="text-text-muted text-[length:var(--fs-12)]">
        신규 멤버는 첫 진입 시 모든 규칙에 동의해야 합니다. 동의 전에는 메시지 전송·리액션이
        차단됩니다. 최대 {WORKSPACE_RULES_MAX}개.
      </p>
      <ul className="flex flex-col gap-[var(--s-2)]">
        {rules.map((rule) => (
          <li
            key={rule.id}
            className="flex items-start justify-between gap-[var(--s-3)] bg-bg-subtle rounded-md p-[var(--s-3)]"
          >
            <div className="flex flex-col gap-[var(--s-1)]">
              <span className="text-text-strong font-medium">{rule.title}</span>
              {rule.description ? (
                <span className="text-text-muted text-[length:var(--fs-13)]">
                  {rule.description}
                </span>
              ) : null}
            </div>
            <Button
              variant="danger"
              size="sm"
              onClick={() => setConfirmDelete(rule)}
              data-testid={`rule-delete-${rule.id}`}
            >
              삭제
            </Button>
          </li>
        ))}
      </ul>
      {rules.length < WORKSPACE_RULES_MAX ? (
        <div className="flex flex-col gap-[var(--s-2)]">
          <Input
            aria-label="규칙 제목"
            placeholder="규칙 제목"
            value={title}
            maxLength={RULE_TITLE_MAX}
            onChange={(e) => setTitle(e.target.value)}
            data-testid="rule-title-input"
          />
          <Input
            aria-label="규칙 설명"
            placeholder="설명 (선택)"
            value={description}
            maxLength={RULE_DESCRIPTION_MAX}
            onChange={(e) => setDescription(e.target.value)}
            data-testid="rule-description-input"
          />
          <div className="flex justify-end">
            <Button
              variant="primary"
              size="sm"
              disabled={!title.trim() || create.isPending}
              onClick={() => create.mutate()}
              data-testid="rule-add"
            >
              규칙 추가
            </Button>
          </div>
        </div>
      ) : null}

      {/* a11y MAJOR-3: 규칙 삭제 확인(되돌릴 수 없음 · alertDialog). */}
      <Dialog
        open={confirmDelete !== null}
        onOpenChange={(o) => {
          if (!o) setConfirmDelete(null);
        }}
        alertDialog
        title="규칙을 삭제할까요?"
        description="삭제한 규칙은 복구할 수 없습니다. 이 작업은 되돌릴 수 없습니다."
      >
        <div className="flex justify-end gap-[var(--s-2)]">
          <Button
            variant="secondary"
            size="sm"
            data-testid="rule-delete-cancel"
            onClick={() => setConfirmDelete(null)}
          >
            취소
          </Button>
          <Button
            variant="danger"
            size="sm"
            data-testid="rule-delete-confirm"
            disabled={remove.isPending}
            onClick={() => {
              const target = confirmDelete;
              setConfirmDelete(null);
              if (target) remove.mutate(target.id);
            }}
          >
            삭제
          </Button>
        </div>
      </Dialog>
    </section>
  );
}

function QuestionsSection({ slug }: { slug: string }): JSX.Element {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['onboarding', 'admin', 'questions', slug],
    queryFn: () => listQuestions(slug),
  });
  const [label, setLabel] = useState('');
  const [type, setType] = useState<QuestionType>('SHORT_TEXT');
  // a11y MAJOR-3: 질문 삭제 확인 대상(alertDialog).
  const [confirmDelete, setConfirmDelete] = useState<OnboardingQuestion | null>(null);
  const invalidate = () =>
    void qc.invalidateQueries({ queryKey: ['onboarding', 'admin', 'questions', slug] });
  const create = useMutation({
    mutationFn: () => createQuestion(slug, { type, isRequired: false, label, options: [] }),
    onSuccess: () => {
      setLabel('');
      invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteQuestion(slug, id),
    onSuccess: invalidate,
  });
  const questions = data?.questions ?? [];

  return (
    <section className="flex flex-col gap-[var(--s-3)]" data-testid="onboarding-questions-section">
      <h3 className="text-text-strong font-semibold text-[length:var(--fs-15)]">
        관심사 질문 (FR-W08)
      </h3>
      <p className="text-text-muted text-[length:var(--fs-12)]">
        신규 멤버가 응답하는 질문입니다. 선택지의 채널/역할 매핑은 추후 편집할 수 있습니다.
      </p>
      <ul className="flex flex-col gap-[var(--s-2)]">
        {questions.map((q) => (
          <li
            key={q.id}
            className="flex items-center justify-between gap-[var(--s-3)] bg-bg-subtle rounded-md p-[var(--s-3)]"
          >
            <span className="text-text-strong">
              {q.label}{' '}
              <span className="text-text-muted text-[length:var(--fs-12)]">({q.type})</span>
            </span>
            <Button
              variant="danger"
              size="sm"
              onClick={() => setConfirmDelete(q)}
              data-testid={`question-delete-${q.id}`}
            >
              삭제
            </Button>
          </li>
        ))}
      </ul>
      <div className="flex gap-[var(--s-2)]">
        <Input
          aria-label="질문"
          placeholder="질문"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          data-testid="question-label-input"
        />
        <select
          aria-label="질문 유형"
          className="qf-input"
          value={type}
          onChange={(e) => setType(e.target.value as QuestionType)}
          data-testid="question-type-select"
        >
          <option value="SINGLE">단일 선택</option>
          <option value="MULTI">다중 선택</option>
          <option value="SHORT_TEXT">서술형</option>
        </select>
        <Button
          variant="primary"
          size="sm"
          disabled={!label.trim() || create.isPending}
          onClick={() => create.mutate()}
          data-testid="question-add"
        >
          추가
        </Button>
      </div>

      {/* a11y MAJOR-3: 질문 삭제 확인(되돌릴 수 없음 · alertDialog). */}
      <Dialog
        open={confirmDelete !== null}
        onOpenChange={(o) => {
          if (!o) setConfirmDelete(null);
        }}
        alertDialog
        title="질문을 삭제할까요?"
        description="삭제한 질문과 선택지 매핑은 복구할 수 없습니다. 이 작업은 되돌릴 수 없습니다."
      >
        <div className="flex justify-end gap-[var(--s-2)]">
          <Button
            variant="secondary"
            size="sm"
            data-testid="question-delete-cancel"
            onClick={() => setConfirmDelete(null)}
          >
            취소
          </Button>
          <Button
            variant="danger"
            size="sm"
            data-testid="question-delete-confirm"
            disabled={remove.isPending}
            onClick={() => {
              const target = confirmDelete;
              setConfirmDelete(null);
              if (target) remove.mutate(target.id);
            }}
          >
            삭제
          </Button>
        </div>
      </Dialog>
    </section>
  );
}

function WelcomeSection({ slug }: { slug: string }): JSX.Element {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['onboarding', 'admin', 'welcome', slug],
    queryFn: () => getWelcome(slug),
  });
  const [message, setMessage] = useState<string | null>(null);
  const value = message ?? data?.welcome?.message ?? '';
  const save = useMutation({
    mutationFn: () =>
      upsertWelcome(slug, { message: value || null, todos: data?.welcome?.todos ?? [] }),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: ['onboarding', 'admin', 'welcome', slug] }),
  });

  return (
    <section className="flex flex-col gap-[var(--s-3)]" data-testid="onboarding-welcome-section">
      <h3 className="text-text-strong font-semibold text-[length:var(--fs-15)]">웰컴 (FR-W09)</h3>
      <p className="text-text-muted text-[length:var(--fs-12)]">
        온보딩 완료 시 신규 멤버에게 보낼 환영 메시지입니다(시스템 DM 으로 발송).
      </p>
      <textarea
        className="qf-input qf-textarea"
        rows={3}
        aria-label="웰컴 메시지"
        maxLength={WELCOME_MESSAGE_MAX}
        value={value}
        onChange={(e) => setMessage(e.target.value)}
        data-testid="welcome-message-input"
      />
      <div className="flex justify-end">
        <Button
          variant="primary"
          size="sm"
          disabled={save.isPending}
          onClick={() => save.mutate()}
          data-testid="welcome-save"
        >
          저장
        </Button>
      </div>
    </section>
  );
}
