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
 */
export function VerifyEmailLanding(): JSX.Element {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { status, refreshMe } = useAuth();
  const [state, setState] = useState<State>({ kind: 'verifying' });
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;
    const token = params.get('token');
    if (!token) {
      setState({ kind: 'invalid' });
      return;
    }
    (async () => {
      try {
        await verifyEmailToken(token);
        setState({ kind: 'success' });
        // 로그인된 세션이면 emailVerified 를 갱신해 게이트를 해제한다.
        if (status === 'authenticated') {
          await refreshMe();
        }
      } catch (e) {
        const err = e as Error & { errorCode?: string };
        setState(
          err.errorCode === 'EMAIL_VERIFICATION_TOKEN_EXPIRED'
            ? { kind: 'expired' }
            : { kind: 'invalid' },
        );
      }
    })();
  }, [params, status, refreshMe]);

  return (
    <main
      data-testid="verify-email-landing"
      className="flex min-h-full items-center justify-center bg-background p-[var(--s-6)]"
    >
      <section className="w-full max-w-md p-[var(--s-9)] text-center" style={CARD_STYLE}>
        <BrandMark variant="wordmark" size={28} className="mb-[var(--s-6)]" />
        {state.kind === 'verifying' && (
          <p
            data-testid="verify-landing-loading"
            className="text-[length:var(--fs-13)] text-text-muted"
          >
            이메일 인증을 확인하는 중…
          </p>
        )}
        {state.kind === 'success' && (
          <>
            <h1 className="text-[length:var(--fs-24)] font-semibold text-text-strong">
              이메일 인증이 완료되었습니다
            </h1>
            <p className="mt-[var(--s-3)] text-[length:var(--fs-13)] text-text-muted">
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
        {(state.kind === 'expired' || state.kind === 'invalid') && (
          <>
            <h1 className="text-[length:var(--fs-20)] font-semibold text-warning">
              인증 링크를 사용할 수 없어요
            </h1>
            <p
              data-testid="verify-landing-error"
              className="mt-[var(--s-3)] text-[length:var(--fs-13)] text-text-muted"
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
      </section>
    </main>
  );
}
