import { useRef, useState } from 'react';
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

// S70 fix-forward (ui LOW): S66/S68 진입 플로우 카드 셸 스타일(시각 일관).
const CARD_STYLE = {
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-xl)',
  boxShadow: 'var(--elev-2)',
} as const;

/**
 * S70 (D13 / FR-W06): 가입 신청 폼. 커스텀 질문(최대 5개) 응답 후 제출한다. 제출 성공 시
 * 대기 화면으로 이동한다. a11y: form 에 제목 aria-labelledby, 필수 질문은 aria-required +
 * sr-only "(필수)", 미응답 시 aria-invalid + role="alert" 오류 + 포커스 이동, 제출 버튼은
 * aria-disabled(포커스 유지 — disabled 대신).
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
  // a11y B-3: 미응답 필수 질문 id(aria-invalid + role="alert" 연결).
  const [invalidId, setInvalidId] = useState<string | null>(null);
  const fieldRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});

  const onSubmit = async (): Promise<void> => {
    if (submitMut.isPending) return; // a11y M-5: aria-disabled 동안 early-return(포커스 유지).
    const payload: ApplicationAnswer[] = qs.map((q) => ({
      questionId: q.id,
      answer: (answers[q.id] ?? '').trim(),
    }));
    // 필수 질문 미응답 가드(클라 — 서버는 형식만 검증). a11y B-3: 토스트 + aria-invalid +
    // 해당 textarea 로 포커스 이동.
    const missing = qs.find((q) => q.required && (answers[q.id] ?? '').trim().length === 0);
    if (missing) {
      setInvalidId(missing.id);
      notify({ variant: 'warning', title: '필수 질문에 답해주세요' });
      fieldRefs.current[missing.id]?.focus();
      return;
    }
    setInvalidId(null);
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
      className="flex min-h-full items-center justify-center bg-background p-[var(--s-6)]"
    >
      <section
        className="w-full max-w-md p-[var(--s-9)]"
        style={CARD_STYLE}
        // a11y H-2: form 영역을 제목으로 라벨링한다.
        aria-labelledby="application-form-title"
      >
        <h1
          id="application-form-title"
          className="text-[length:var(--fs-18)] font-semibold text-text-strong"
        >
          {workspaceName ? `${workspaceName} 가입 신청` : '가입 신청'}
        </h1>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void onSubmit();
          }}
          className="mt-[var(--s-4)] flex flex-col gap-[var(--s-4)]"
        >
          {qs.map((q) => {
            const errId = `application-answer-${q.id}-error`;
            const isInvalid = invalidId === q.id;
            return (
              <label key={q.id} className="flex flex-col gap-[var(--s-1)]">
                <span className="text-[length:var(--fs-13)] text-text-secondary">
                  {q.label}
                  {q.required ? (
                    <>
                      {/* a11y H-1: 시각적 * 는 aria-hidden, AT 에는 sr-only "(필수)". */}
                      <span aria-hidden className="ml-[var(--s-1)] text-text-strong">
                        *
                      </span>
                      <span className="sr-only">(필수)</span>
                    </>
                  ) : null}
                </span>
                <textarea
                  ref={(el) => {
                    fieldRefs.current[q.id] = el;
                  }}
                  data-testid={`application-answer-${q.id}`}
                  className="qf-input qf-textarea"
                  rows={3}
                  maxLength={2000}
                  // a11y H-1: required 표시를 AT 에 전달.
                  aria-required={q.required ? true : undefined}
                  // a11y B-3: 미응답 필수 질문은 aria-invalid + 오류 메시지 연결.
                  aria-invalid={isInvalid || undefined}
                  aria-describedby={isInvalid ? errId : undefined}
                  value={answers[q.id] ?? ''}
                  onChange={(e) => {
                    const v = e.target.value;
                    setAnswers((prev) => ({ ...prev, [q.id]: v }));
                    if (isInvalid && v.trim().length > 0) setInvalidId(null);
                  }}
                />
                {isInvalid ? (
                  <span id={errId} role="alert" className="text-[length:var(--fs-13)] text-danger">
                    이 질문은 필수입니다.
                  </span>
                ) : null}
              </label>
            );
          })}
          <Button
            type="submit"
            variant="primary"
            data-testid="application-submit"
            // a11y M-5: disabled 대신 aria-disabled + aria-busy(포커스 유지 · onClick early-return).
            aria-disabled={submitMut.isPending || undefined}
            aria-busy={submitMut.isPending || undefined}
          >
            신청 제출
          </Button>
          {submitMut.isPending ? (
            <p
              role="status"
              aria-busy="true"
              className="text-[length:var(--fs-13)] text-text-muted"
            >
              제출 중…
            </p>
          ) : null}
        </form>
      </section>
    </main>
  );
}
