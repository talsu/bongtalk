import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { APPLICATION_MAX_ANSWERS, type ApplicationAnswer } from '@qufox/shared-types';
import { Button } from '../../design-system/primitives';
import { useNotifications } from '../../stores/notification-store';
import { useSubmitApplication } from './useApplications';

type Props = {
  /** 신청 API 라우팅 키(slug). */
  slug: string;
  /** 워크스페이스 표시명(헤더 카피). */
  workspaceName?: string;
  /**
   * 커스텀 질문 목록(최대 5). 질문 카탈로그(OnboardingQuestion)는 carryover 라, 호출부가
   * 질문을 넘기지 않으면 자유 형식 자기소개 1문항으로 폴백한다(서버는 answers 만 저장).
   */
  questions?: Array<{ id: string; label: string; required?: boolean }>;
};

const DEFAULT_QUESTIONS = [{ id: 'intro', label: '간단한 자기소개를 남겨주세요', required: false }];

/**
 * S70 (D13 / FR-W06): 가입 신청 폼. 커스텀 질문(최대 5개) 응답 후 제출한다. 제출 성공 시
 * 대기 화면으로 이동한다. a11y: 각 질문에 라벨 연결 + 제출 상태 라이브 영역.
 */
export function ApplicationForm({ slug, workspaceName, questions }: Props): JSX.Element {
  const navigate = useNavigate();
  const notify = useNotifications((s) => s.push);
  const submitMut = useSubmitApplication(slug);
  const qs = (questions && questions.length > 0 ? questions : DEFAULT_QUESTIONS).slice(
    0,
    APPLICATION_MAX_ANSWERS,
  );
  const [answers, setAnswers] = useState<Record<string, string>>({});

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const payload: ApplicationAnswer[] = qs.map((q) => ({
      questionId: q.id,
      answer: (answers[q.id] ?? '').trim(),
    }));
    // 필수 질문 미응답 가드(클라 — 서버는 형식만 검증).
    const missing = qs.find((q) => q.required && (answers[q.id] ?? '').trim().length === 0);
    if (missing) {
      notify({ variant: 'warning', title: '필수 질문에 답해주세요' });
      return;
    }
    try {
      await submitMut.mutateAsync(payload);
      notify({ variant: 'success', title: '가입 신청을 제출했습니다' });
      navigate(`/w/${slug}/pending`);
    } catch {
      notify({ variant: 'danger', title: '신청 제출에 실패했습니다' });
    }
  };

  return (
    <main
      data-testid="application-form-page"
      className="mx-auto flex max-w-[var(--container-sm,32rem)] flex-col gap-[var(--s-4)] p-[var(--s-6)]"
    >
      <h1 className="text-[length:var(--fs-18)] font-semibold text-text-strong">
        {workspaceName ? `${workspaceName} 가입 신청` : '가입 신청'}
      </h1>
      <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-[var(--s-4)]">
        {qs.map((q) => (
          <label key={q.id} className="flex flex-col gap-[var(--s-1)]">
            <span className="text-[length:var(--fs-13)] text-text-secondary">
              {q.label}
              {q.required ? <span className="ml-[var(--s-1)] text-text-strong">*</span> : null}
            </span>
            <textarea
              data-testid={`application-answer-${q.id}`}
              className="qf-input"
              rows={3}
              maxLength={2000}
              required={q.required}
              value={answers[q.id] ?? ''}
              onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
            />
          </label>
        ))}
        <Button
          type="submit"
          variant="primary"
          data-testid="application-submit"
          disabled={submitMut.isPending}
        >
          신청 제출
        </Button>
        {submitMut.isPending ? (
          <p role="status" aria-busy="true" className="text-[length:var(--fs-13)] text-text-muted">
            제출 중…
          </p>
        ) : null}
      </form>
    </main>
  );
}
