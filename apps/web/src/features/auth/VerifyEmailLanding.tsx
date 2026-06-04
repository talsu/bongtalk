import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '../../design-system/primitives';
import { BrandMark } from '../../design-system/brand/BrandMark';
import { verifyEmailToken } from '../../lib/api';
import { useAuth } from './AuthProvider';

const CARD_STYLE = {
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-xl)',
  boxShadow: 'var(--elev-2)',
} as const;

type State =
  | { kind: 'verifying' }
  | { kind: 'success' }
  | { kind: 'expired' }
  | { kind: 'invalid' };

/**
 * S66 (D13 / FR-W05b): 이메일 인증 링크 랜딩. 메일 본문의 verifyUrl
 * (WEB_URL/verify-email?token=…)을 브라우저로 열면 이 페이지가 GET /auth/verify-email 을
 * 호출해 토큰을 검증한다. 성공 시 세션이 살아있으면 refreshMe 로 emailVerified 를 갱신해
 * 곧장 진입할 수 있게 한다(만료 410 / 무효 400 은 안내 분기).
 *
 * S66 fix-forward:
 * - (m3) 토큰 검증(ranRef 가드)과 refreshMe(status 의존)를 분리한다. 검증 success 이고
 *   세션이 authenticated 가 될 때 별도 effect 가 refreshMe 를 호출해, 로그인 사용자가
 *   stale emailVerified=false 로 게이트에 다시 갇히는 문제를 막는다.
 * - (MEDIUM-3) 토큰 추출 직후 history.replaceState 로 ?token= 을 URL 에서 제거해
 *   Referer/로그/히스토리 노출을 완화한다.
 * - (A4/A5/C2) 진행/결과를 라이브 영역(status/alert)으로 감싸 전환을 자동 고지한다.
 * - (B3) 진입·상태전환 시 결과 h1 으로 포커스를 옮긴다.
 * - (C1) section 을 h1 id 로 라벨링한다. (C3) document.title 을 state 별로 갱신한다.
 */
export function VerifyEmailLanding(): JSX.Element {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { status, refreshMe } = useAuth();
  const [state, setState] = useState<State>({ kind: 'verifying' });
  const ranRef = useRef(false);
  const refreshedRef = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // 토큰 검증은 마운트당 1회만 실행한다(ranRef 가드 — status 변화에 재실행되지 않게 분리).
  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;
    const token = params.get('token');
    // (MEDIUM-3) 토큰을 추출하자마자 URL 에서 ?token= 을 제거한다(노출 완화). 검증에는
    // 추출해둔 token 변수를 쓴다.
    if (token && typeof window !== 'undefined') {
      window.history.replaceState(null, '', window.location.pathname);
    }
    if (!token) {
      setState({ kind: 'invalid' });
      return;
    }
    (async () => {
      try {
        await verifyEmailToken(token);
        setState({ kind: 'success' });
      } catch (e) {
        const err = e as Error & { errorCode?: string };
        setState(
          err.errorCode === 'EMAIL_VERIFICATION_TOKEN_EXPIRED'
            ? { kind: 'expired' }
            : { kind: 'invalid' },
        );
      }
    })();
  }, [params]);

  // (m3) 검증 success 이고 세션이 authenticated 가 되면 refreshMe 로 stale emailVerified
  // 를 갱신한다(토큰 검증과 분리 — status 가 늦게 authenticated 로 바뀌어도 한 번은 동작).
  useEffect(() => {
    if (state.kind !== 'success') return;
    if (status !== 'authenticated') return;
    if (refreshedRef.current) return;
    refreshedRef.current = true;
    void refreshMe();
  }, [state.kind, status, refreshMe]);

  // (C3) document.title 을 상태별로 갱신한다.
  useEffect(() => {
    document.title =
      state.kind === 'success'
        ? '이메일 인증 완료 | qufox'
        : state.kind === 'verifying'
          ? '이메일 인증 | qufox'
          : '인증 링크 오류 | qufox';
  }, [state.kind]);

  // (B3) 진입 + 상태전환 시 결과 제목으로 포커스를 옮긴다(결과를 AT 가 즉시 읽도록).
  useEffect(() => {
    headingRef.current?.focus();
  }, [state.kind]);

  const isError = state.kind === 'expired' || state.kind === 'invalid';

  return (
    <main
      data-testid="verify-email-landing"
      className="flex min-h-full items-center justify-center bg-background p-[var(--s-6)]"
    >
      <section
        aria-labelledby="verify-landing-heading"
        className="w-full max-w-md p-[var(--s-9)] text-center"
        style={CARD_STYLE}
      >
        <BrandMark variant="wordmark" size={28} className="mb-[var(--s-6)]" />
        {/* (A4/A5/C2) verifying·success 는 polite status, expired·invalid 는 assertive
            alert 로 감싸 전환을 자동 고지한다. */}
        <div role={isError ? 'alert' : 'status'} aria-live={isError ? 'assertive' : 'polite'}>
          {state.kind === 'verifying' && (
            <>
              <h1 ref={headingRef} id="verify-landing-heading" tabIndex={-1} className="sr-only">
                이메일 인증을 확인하는 중
              </h1>
              <p
                data-testid="verify-landing-loading"
                className="text-[var(--fs-13)] text-text-muted"
              >
                이메일 인증을 확인하는 중…
              </p>
            </>
          )}
          {state.kind === 'success' && (
            <>
              <h1
                ref={headingRef}
                id="verify-landing-heading"
                tabIndex={-1}
                className="text-[var(--fs-24)] font-semibold text-text-strong"
              >
                이메일 인증이 완료되었습니다
              </h1>
              <p className="mt-[var(--s-3)] text-[var(--fs-13)] text-text-muted">
                이제 워크스페이스에 참여하고 대화를 시작할 수 있습니다.
              </p>
              <Button
                type="button"
                data-testid="verify-landing-continue"
                size="lg"
                className="mt-[var(--s-7)] w-full"
                onClick={() => navigate('/', { replace: true })}
              >
                계속하기
              </Button>
            </>
          )}
          {isError && (
            <>
              <h1
                ref={headingRef}
                id="verify-landing-heading"
                tabIndex={-1}
                className="text-[var(--fs-20)] font-semibold text-text-strong"
              >
                인증 링크를 사용할 수 없어요
              </h1>
              <p
                data-testid="verify-landing-error"
                className="mt-[var(--s-3)] text-[var(--fs-13)] text-text-muted"
              >
                {state.kind === 'expired'
                  ? '인증 링크가 만료되었습니다. 로그인 후 인증 메일을 다시 보내 주세요.'
                  : '인증 링크가 유효하지 않습니다. 로그인 후 인증 메일을 다시 보내 주세요.'}
              </p>
              <Link
                to="/login"
                className="qf-btn qf-btn--primary qf-btn--lg mt-[var(--s-7)] inline-flex w-full justify-center"
              >
                로그인으로 이동
              </Link>
            </>
          )}
        </div>
      </section>
    </main>
  );
}
