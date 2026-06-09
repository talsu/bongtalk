import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { ResetPasswordRequestSchema } from '@qufox/shared-types';
import { z } from 'zod';
import { Button, Input, Icon, StrengthMeter } from '../../design-system/primitives';
import { BrandMark } from '../../design-system/brand/BrandMark';
import { resetPassword } from '../../lib/api';

const CARD_STYLE = {
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-xl)',
  boxShadow: 'var(--elev-2)',
} as const;

// 폼은 비밀번호만 받는다(토큰은 URL 에서 추출해 따로 보관). 정책은 shared PasswordSchema 재사용.
const ResetFormSchema = ResetPasswordRequestSchema.pick({ password: true });
type ResetForm = z.infer<typeof ResetFormSchema>;

type Phase = 'form' | 'done' | 'token-error';

// (A1) 단계별 document.title.
const TITLE_BY_PHASE: Record<Phase, string> = {
  form: '새 비밀번호 설정 | qufox',
  done: '변경 완료 | qufox',
  'token-error': '링크 오류 | qufox',
};

// (A2) 단계별 heading 텍스트(단일 h1 텍스트만 갱신).
const HEADING_BY_PHASE: Record<Phase, string> = {
  form: '새 비밀번호 설정',
  done: '변경 완료',
  'token-error': '링크 오류',
};

// 단계별 부제(설명) 카피.
const SUBTITLE_BY_PHASE: Record<Phase, string> = {
  form: '새로 사용할 비밀번호를 입력해 주세요.',
  done: '새 비밀번호로 다시 로그인해 주세요.',
  'token-error': '재설정 링크가 만료되었거나 유효하지 않습니다.',
};

/**
 * AUTH-3 (PRD D18 §5 / FR-AUTH-41·42): 비밀번호 재설정. URL ?token= 을 읽어 보관하고, 새
 * 비밀번호 + StrengthMeter + "변경 후 모든 기기에서 다시 로그인" 경고(.qf-notice--warn)를
 * 보여준다. 성공 시 "변경되었습니다" 후 /login 으로 이동한다. 토큰 만료/무효 시
 * .qf-notice--danger + "다시 요청"(/forgot-password) 경로로 분기한다.
 *
 * 랜딩 시 ?token= 을 history.replaceState 로 제거한다(Referer/로그/히스토리 노출 완화 —
 * VerifyEmailLanding MEDIUM-3 패턴).
 *
 * AUTH-3 fix-forward (a11y · EmailVerificationGate 정본 패턴):
 * - (A1) document.title 을 phase 별로 useEffect 로 설정.
 * - (A2) <section aria-labelledby> + <h1 id tabIndex={-1} ref>. h1 텍스트는 phase 별 갱신.
 * - (A3) 장식 eyebrow 는 aria-hidden(대비 미달 토큰).
 * - (A4) phase 가 'done'/'token-error' 로 바뀌면 useEffect [phase] 로 heading 에 포커스 이동.
 * - (A5) 토큰 없는 직접 진입은 마운트 시 즉시 token-error 로 분기(빈 폼 노출 방지).
 */
export function ResetPasswordPage(): JSX.Element {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  // 토큰은 최초 렌더에서 1회만 추출해 보관한다(이후 URL 에서 제거되므로 params 재조회 불가).
  const tokenRef = useRef<string | null>(null);
  if (tokenRef.current === null) tokenRef.current = params.get('token') ?? '';
  const token = tokenRef.current;

  // (A5) 토큰이 아예 없으면(직접 진입/링크 손상) 초기 phase 를 token-error 로 둔다 — 검증 가능
  // 토큰이 없는데 빈 폼을 노출하지 않는다.
  const [phase, setPhase] = useState<Phase>(token ? 'form' : 'token-error');
  const [serverError, setServerError] = useState<string | null>(null);
  const strippedRef = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // 랜딩 직후 ?token= 을 URL 에서 제거한다(노출 완화). 검증에는 tokenRef 의 값을 쓴다.
  useEffect(() => {
    if (strippedRef.current) return;
    strippedRef.current = true;
    if (token && typeof window !== 'undefined') {
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, [token]);

  // (A1) 단계별 document.title. (A4) phase 전환 시 heading 으로 포커스 이동(전환 고지).
  useEffect(() => {
    document.title = TITLE_BY_PHASE[phase];
    headingRef.current?.focus();
  }, [phase]);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<ResetForm>({ resolver: zodResolver(ResetFormSchema) });
  const password = watch('password') ?? '';

  const onSubmit = handleSubmit(async (values) => {
    setServerError(null);
    if (!token) {
      setPhase('token-error');
      return;
    }
    try {
      await resetPassword(token, values.password);
      setPhase('done');
    } catch (e) {
      const err = e as Error & { errorCode?: string };
      if (
        err.errorCode === 'PASSWORD_RESET_TOKEN_EXPIRED' ||
        err.errorCode === 'PASSWORD_RESET_TOKEN_INVALID'
      ) {
        setPhase('token-error');
        return;
      }
      // 그 외(정책 미달 등 422/400)는 폼을 유지하고 에러 메시지만 노출한다.
      setServerError(err.message);
    }
  });

  return (
    <main className="flex min-h-full items-center justify-center bg-background p-[var(--s-6)]">
      <section
        aria-labelledby="reset-heading"
        className="w-full max-w-md p-[var(--s-9)]"
        style={CARD_STYLE}
      >
        <div className="mb-[var(--s-7)] flex flex-col items-center text-center">
          <BrandMark variant="symbol" size={56} decorative className="mb-[var(--s-5)]" />
          {/* (A3) 장식 eyebrow — 대비 미달 토큰이므로 AT 에서 숨긴다. */}
          <div className="qf-eyebrow mb-[var(--s-3)]" aria-hidden="true">
            qufox · reset
          </div>
          <h1
            ref={headingRef}
            id="reset-heading"
            tabIndex={-1}
            className="text-[var(--fs-24)] font-semibold tracking-[var(--tracking-tight)] text-text-strong"
          >
            {HEADING_BY_PHASE[phase]}
          </h1>
          <p className="mt-[var(--s-2)] text-[length:var(--fs-13)] text-text-muted">
            {SUBTITLE_BY_PHASE[phase]}
          </p>
        </div>

        {phase === 'done' && (
          <div data-testid="reset-done" role="status" aria-live="polite" className="text-center">
            <p className="text-[length:var(--fs-15)] text-text-strong">변경되었습니다.</p>
            <p className="mt-[var(--s-2)] text-[length:var(--fs-13)] text-text-muted">
              새 비밀번호로 다시 로그인해 주세요.
            </p>
            <Button
              type="button"
              data-testid="reset-go-login"
              size="lg"
              className="mt-[var(--s-7)] w-full"
              onClick={() => navigate('/login', { replace: true })}
            >
              로그인하기
            </Button>
          </div>
        )}

        {phase === 'token-error' && (
          <div data-testid="reset-token-error" role="alert" className="text-center">
            <div className="qf-notice qf-notice--danger text-left">
              <Icon name="alert" className="qf-notice__icon" aria-hidden />
              <div className="qf-notice__body">
                재설정 링크가 만료되었거나 유효하지 않습니다. 다시 요청해 주세요.
              </div>
            </div>
            <Link
              to="/forgot-password"
              data-testid="reset-request-again"
              className="qf-btn qf-btn--primary qf-btn--lg mt-[var(--s-7)] inline-flex w-full justify-center"
            >
              재설정 링크 다시 요청
            </Link>
          </div>
        )}

        {phase === 'form' && (
          <form className="mt-[var(--s-7)] flex flex-col gap-[var(--s-5)]" onSubmit={onSubmit}>
            {/* 변경 후 모든 기기에서 재로그인이 필요함을 미리 안내한다(.qf-notice--warn). */}
            <div data-testid="reset-warn-notice" className="qf-notice qf-notice--warn">
              <Icon name="alert" className="qf-notice__icon" aria-hidden />
              <div className="qf-notice__body">변경 후 모든 기기에서 다시 로그인이 필요해요.</div>
            </div>
            <div className="qf-field">
              <label className="qf-field__label" htmlFor="reset-password">
                새 비밀번호
              </label>
              <Input
                id="reset-password"
                data-testid="reset-password"
                type="password"
                autoComplete="new-password"
                invalid={!!errors.password}
                {...register('password')}
              />
              {errors.password && <p className="qf-field__error">{errors.password.message}</p>}
              <StrengthMeter password={password} />
            </div>
            {serverError && (
              <p data-testid="reset-error" role="alert" className="qf-field__error">
                {serverError}
              </p>
            )}
            <Button
              data-testid="reset-submit"
              type="submit"
              disabled={isSubmitting}
              size="lg"
              className="w-full"
            >
              {isSubmitting ? '변경 중…' : '비밀번호 변경'}
            </Button>
          </form>
        )}
      </section>
    </main>
  );
}
