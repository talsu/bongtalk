import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { ForgotPasswordRequest, ForgotPasswordRequestSchema } from '@qufox/shared-types';
import { Button, Input } from '../../design-system/primitives';
import { BrandMark } from '../../design-system/brand/BrandMark';
import { forgotPassword } from '../../lib/api';

const CARD_STYLE = {
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-xl)',
  boxShadow: 'var(--elev-2)',
} as const;

/**
 * AUTH-3 (PRD D18 §5 / FR-AUTH-40): 비밀번호 찾기. 이메일 단일 필드 + "재설정 링크 보내기".
 *
 * 제출 후에는 계정 존재 여부와 무관하게 **항상 동일한 확인 화면**을 보여준다(서버가 항상 200
 * 으로 응답하므로 클라이언트도 존재 여부를 노출하지 않는다 — 계정 열거 방어). 확인 화면은
 * role="status" 라이브 영역으로 감싸 SR 가 전환을 고지받게 한다. 브랜드 심볼은 로그인과 동일
 * decorative 중앙 블록으로 둔다.
 *
 * AUTH-3 fix-forward (a11y · EmailVerificationGate 정본 패턴):
 * - (A1) document.title 을 마운트/상태 전환 시 useEffect 로 설정(폼='비밀번호 찾기', sent=
 *   '메일 발송 완료').
 * - (A2) <section aria-labelledby> + <h1 id tabIndex={-1} ref>. h1 텍스트는 단계에 맞춰
 *   갱신(폼='비밀번호를 잊으셨나요?', sent='메일을 보냈어요').
 * - (A3) 장식 eyebrow 는 aria-hidden(대비 미달 토큰).
 * - (A4) sent 로 전환되면 useEffect [sent] 로 heading 에 포커스를 옮겨 전환을 알린다.
 */
export function ForgotPasswordPage(): JSX.Element {
  const [sent, setSent] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ForgotPasswordRequest>({ resolver: zodResolver(ForgotPasswordRequestSchema) });

  // (A1) document.title — 단계별로 재설정한다. (A4) sent 전환 시 heading 으로 포커스 이동.
  useEffect(() => {
    document.title = sent ? '메일 발송 완료 | qufox' : '비밀번호 찾기 | qufox';
    headingRef.current?.focus();
  }, [sent]);

  const onSubmit = handleSubmit(async (values) => {
    try {
      await forgotPassword(values.email);
    } catch {
      // 네트워크/서버 오류여도 존재 여부를 노출하지 않도록 동일한 확인 화면으로 전환한다
      // (열거 방어 — 성공/실패 분기 자체가 신호가 되지 않게 한다).
    }
    setSent(true);
  });

  // (A2) 단계별 heading 텍스트 — h1 은 하나만 두고 텍스트만 갱신한다(LOW-1: 확인화면 카피와 정합).
  const headingText = sent ? '메일을 보냈어요' : '비밀번호를 잊으셨나요?';

  return (
    <main className="flex min-h-full items-center justify-center bg-background p-[var(--s-6)]">
      <section
        aria-labelledby="forgot-heading"
        className="w-full max-w-md p-[var(--s-9)]"
        style={CARD_STYLE}
      >
        {/* 로그인/가입과 동일한 심볼+eyebrow 중앙 정렬 블록(decorative 심볼 — WCAG 1.1.1). */}
        <div className="mb-[var(--s-7)] flex flex-col items-center text-center">
          <BrandMark variant="symbol" size={56} decorative className="mb-[var(--s-5)]" />
          {/* (A3) 장식 eyebrow — 대비 미달 토큰이므로 AT 에서 숨긴다. */}
          <div className="qf-eyebrow mb-[var(--s-3)]" aria-hidden="true">
            qufox · forgot
          </div>
          <h1
            ref={headingRef}
            id="forgot-heading"
            tabIndex={-1}
            className="text-[length:var(--fs-24)] font-semibold tracking-[var(--tracking-tight)] text-text-strong"
          >
            {headingText}
          </h1>
          <p className="mt-[var(--s-2)] text-[length:var(--fs-13)] text-text-muted">
            {sent
              ? '받은 편지함을 확인하세요. 메일이 보이지 않으면 스팸함도 확인해 주세요.'
              : '가입한 이메일로 재설정 링크를 보내 드려요.'}
          </p>
        </div>

        {sent ? (
          // 제출 후 항상 동일한 확인 화면(존재 여부 비노출). role="status" 로 SR 고지.
          <div data-testid="forgot-sent" role="status" aria-live="polite" className="text-center">
            <p className="text-[length:var(--fs-15)] text-text-strong">
              입력하신 주소로 메일을 보냈어요.
            </p>
            <Link
              to="/login"
              className="qf-btn qf-btn--primary qf-btn--lg mt-[var(--s-7)] inline-flex w-full justify-center"
            >
              로그인으로 돌아가기
            </Link>
          </div>
        ) : (
          <form className="mt-[var(--s-7)] flex flex-col gap-[var(--s-5)]" onSubmit={onSubmit}>
            <div className="qf-field">
              <label className="qf-field__label" htmlFor="forgot-email">
                Email
              </label>
              <Input
                id="forgot-email"
                data-testid="forgot-email"
                type="email"
                autoComplete="email"
                invalid={!!errors.email}
                {...register('email')}
              />
              {errors.email && <p className="qf-field__error">{errors.email.message}</p>}
            </div>
            <Button
              data-testid="forgot-submit"
              type="submit"
              disabled={isSubmitting}
              size="lg"
              className="w-full"
            >
              {isSubmitting ? '보내는 중…' : '재설정 링크 보내기'}
            </Button>
          </form>
        )}

        <p className="mt-[var(--s-6)] text-[length:var(--fs-13)] text-text-muted">
          비밀번호가 기억나셨나요?{' '}
          <Link to="/login" className="font-medium text-link hover:text-link-hover">
            로그인
          </Link>
        </p>
      </section>
    </main>
  );
}
