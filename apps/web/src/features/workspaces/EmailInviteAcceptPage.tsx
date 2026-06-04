import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Button, Icon } from '../../design-system/primitives';
import { useAuth } from '../auth/AuthProvider';
import { acceptEmailInvite, acceptEmailInviteByOpaque, exchangeEmailInviteToken } from './api';
import { InviteExpired } from './InviteExpired';

/**
 * S68 (D13 / FR-W04a): 이메일 직접 초대 수락 4분기.
 *   ① 미가입 → exchange 로 rawToken 을 opaque 코드로 교환 → 회원가입 리다이렉트(URL 엔
 *      opaque 코드만) → 가입 후 opaque 검증으로 자동 수락.
 *   ② 가입 + 이메일 일치 로그인 → 즉시 수락.
 *   ③ 가입 + 다른 계정 로그인(또는 이메일 불일치) → 계정 확인 안내(다른 계정/로그아웃 권고).
 *   ④ 토큰 만료/무효 → 410 → 만료 화면.
 *
 * 보안(★핵심 AC): rawToken 은 URL **fragment**(#token=…)로만 들어온다(security MEDIUM-1 —
 * fragment 는 서버/nginx 로 전송되지 않아 access 로그에 평문이 남지 않는다). 토큰은 location.hash
 * 에서 읽어 교환/수락 POST 바디로만 보내고, 미가입 분기는 opaque 코드로 교환한 뒤 회원가입 URL
 * 엔 opaque 코드만 둔다.
 */

// 토큰 만료/소진(410) → 전용 만료 화면으로 분기.
const EXPIRED_CODES = new Set(['EMAIL_INVITE_EXPIRED']);

const CARD_STYLE = {
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-xl)',
  boxShadow: 'var(--elev-2)',
} as const;

type ViewState =
  | { kind: 'loading' }
  | { kind: 'self-confirm' } // ② 이메일 일치 로그인 사용자에게 수락 버튼 제시
  | { kind: 'other-account' } // ③ 다른 계정 / 이메일 불일치 안내
  | { kind: 'expired' } // ④
  | { kind: 'error'; message: string };

/**
 * S68 fix-forward (security MEDIUM-1): rawToken 을 URL fragment(#token=…)에서 읽는다.
 * 하위호환으로 path param(useParams().token)도 폴백 처리한다(있더라도 신규 라우트엔 없음).
 */
function readTokenFromHash(): string | null {
  if (typeof window === 'undefined') return null;
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  return params.get('token');
}

export function EmailInviteAcceptPage(): JSX.Element {
  const { slug, token: pathToken } = useParams();
  const [searchParams] = useSearchParams();
  // 가입 직후 자동 수락 흐름: /w/:slug/email-invite?opaque=<code>
  const opaque = searchParams.get('opaque');
  // rawToken 은 fragment(#token=…)에서 읽는다(security MEDIUM-1). path param 은 폴백.
  const token = useMemo(() => readTokenFromHash() ?? pathToken ?? null, [pathToken]);
  const navigate = useNavigate();
  const { status, user } = useAuth();
  const [view, setView] = useState<ViewState>({ kind: 'loading' });
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // S68 a11y (HIGH-3): 각 분기 진입 시 h1 로 포커스를 옮긴다(InviteExpired 패턴).
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  const errorCodeOf = (e: unknown): string | undefined =>
    (e as Error & { errorCode?: string }).errorCode;

  // 분기 ①(가입 후): opaque 코드로 자동 수락.
  useEffect(() => {
    if (!opaque || !slug) return;
    if (status !== 'authenticated') return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await acceptEmailInviteByOpaque(slug, opaque);
        if (!cancelled) navigate(`/w/${res.workspace.slug}`, { replace: true });
      } catch (e) {
        if (cancelled) return;
        const ec = errorCodeOf(e);
        if (EXPIRED_CODES.has(ec ?? '')) setView({ kind: 'expired' });
        else if (ec === 'EMAIL_INVITE_EMAIL_MISMATCH') setView({ kind: 'other-account' });
        else setView({ kind: 'error', message: (e as Error).message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [opaque, slug, status, navigate]);

  // rawToken 분기 결정(②③ 또는 ① 미가입 교환).
  useEffect(() => {
    if (opaque) return; // opaque 흐름은 위 effect 가 처리.
    if (!slug || !token) return;
    if (status === 'loading') return;

    let cancelled = false;
    void (async () => {
      // 비로그인 또는 가입 안 한 흐름: rawToken 을 opaque 로 교환해 회원가입으로 보낸다.
      if (status === 'anonymous') {
        try {
          const res = await exchangeEmailInviteToken(slug, token);
          if (cancelled) return;
          // ★핵심 AC: 회원가입 URL 엔 opaque 코드만 싣는다(rawToken 미노출).
          const next = encodeURIComponent(`/w/${slug}/email-invite?opaque=${res.opaqueCode}`);
          navigate(`/signup?from=${next}&email=${encodeURIComponent(res.email)}`, {
            replace: true,
          });
        } catch (e) {
          if (cancelled) return;
          if (EXPIRED_CODES.has(errorCodeOf(e) ?? '')) setView({ kind: 'expired' });
          else setView({ kind: 'error', message: (e as Error).message });
        }
        return;
      }
      // 로그인 사용자: 즉시 수락 시도. 401/403/role/만료 등은 아래에서 분기 안내.
      setView({ kind: 'self-confirm' });
    })();
    return () => {
      cancelled = true;
    };
  }, [opaque, slug, token, status, navigate]);

  // S68 a11y (HIGH-3): 분기 진입 시 document.title + h1 포커스.
  useEffect(() => {
    const titleByView: Record<ViewState['kind'], string> = {
      loading: '초대 확인 중 · qufox',
      'self-confirm': '워크스페이스 초대 수락 · qufox',
      'other-account': '다른 계정으로 초대됨 · qufox',
      expired: '초대 만료 · qufox',
      error: '초대 링크 오류 · qufox',
    };
    document.title = titleByView[view.kind];
    if (view.kind !== 'loading' && view.kind !== 'expired') {
      headingRef.current?.focus();
    }
  }, [view.kind]);

  const onAccept = async (): Promise<void> => {
    if (!slug || !token) return;
    setAcceptError(null);
    setBusy(true);
    try {
      const res = await acceptEmailInvite(slug, token);
      navigate(`/w/${res.workspace.slug}`, { replace: true });
    } catch (e) {
      const ec = errorCodeOf(e);
      if (EXPIRED_CODES.has(ec ?? '')) {
        setView({ kind: 'expired' });
      } else if (ec === 'WORKSPACE_DOMAIN_NOT_ALLOWED') {
        setAcceptError('허용된 이메일 도메인의 계정만 참여할 수 있습니다.');
      } else if (ec === 'EMAIL_NOT_VERIFIED') {
        setAcceptError('이메일 인증 후 초대를 수락할 수 있습니다.');
      } else if (
        ec === 'EMAIL_INVITE_EMAIL_MISMATCH' ||
        ec === 'EMAIL_INVITE_TOKEN_INVALID' ||
        ec === 'EMAIL_INVITE_ROLE_MISMATCH'
      ) {
        // 이 계정으로는 수락 불가(이메일 불일치/위조) → 다른 계정 안내(분기 ③).
        // ★서버 강제(reviewer B1): 초대 대상이 아닌 계정의 수락은 403 으로 거부된다.
        setView({ kind: 'other-account' });
      } else {
        setAcceptError('초대를 수락할 수 없습니다. 잠시 후 다시 시도해 주세요.');
      }
    } finally {
      setBusy(false);
    }
  };

  if (view.kind === 'expired') {
    return <InviteExpired />;
  }

  if (view.kind === 'loading') {
    return (
      <div
        data-testid="email-invite-loading"
        role="status"
        className="qf-empty flex min-h-full items-center justify-center"
      >
        <div className="qf-empty__body">초대를 확인하는 중…</div>
      </div>
    );
  }

  if (view.kind === 'error') {
    return (
      <main className="flex min-h-full items-center justify-center bg-background p-[var(--s-6)]">
        <section
          data-testid="email-invite-invalid"
          aria-labelledby="email-invite-error-heading"
          className="max-w-md p-[var(--s-9)] text-center"
          style={CARD_STYLE}
        >
          <h1
            id="email-invite-error-heading"
            ref={headingRef}
            tabIndex={-1}
            className="text-[length:var(--fs-20)] font-semibold text-text-strong outline-none"
          >
            초대 링크를 사용할 수 없어요
          </h1>
          <p className="mt-[var(--s-3)] text-[length:var(--fs-13)] text-text-muted">
            {view.message}
          </p>
        </section>
      </main>
    );
  }

  if (view.kind === 'other-account') {
    return (
      <main className="flex min-h-full items-center justify-center bg-background p-[var(--s-6)]">
        <section
          data-testid="email-invite-other-account"
          aria-labelledby="email-invite-other-heading"
          className="w-full max-w-md p-[var(--s-9)] text-center"
          style={CARD_STYLE}
        >
          <h1
            id="email-invite-other-heading"
            ref={headingRef}
            tabIndex={-1}
            className="text-[length:var(--fs-20)] font-semibold text-text-strong outline-none"
          >
            다른 계정으로 초대되었습니다
          </h1>
          <p className="mt-[var(--s-3)] text-[length:var(--fs-13)] text-text-muted">
            이 초대는 현재 로그인한 계정({user?.email})이 아닌 다른 이메일로 발송되었습니다.
            초대받은 이메일 계정으로 로그인한 뒤 다시 시도해 주세요.
          </p>
          <div className="mt-[var(--s-7)] flex flex-col gap-[var(--s-3)] text-[length:var(--fs-13)]">
            <Link
              to={`/login?from=${encodeURIComponent(`/w/${slug}/email-invite`)}`}
              className="qf-btn qf-btn--primary qf-btn--lg"
            >
              다른 계정으로 로그인
            </Link>
          </div>
        </section>
      </main>
    );
  }

  // ② self-confirm: 이메일 일치 로그인 사용자에게 수락 버튼.
  return (
    <main className="flex min-h-full items-center justify-center bg-background p-[var(--s-6)]">
      <section
        aria-labelledby="email-invite-confirm-heading"
        className="w-full max-w-md p-[var(--s-9)] text-center"
        style={CARD_STYLE}
      >
        <div className="qf-eyebrow mb-[var(--s-3)]" aria-hidden="true">
          workspace invite
        </div>
        <h1
          id="email-invite-confirm-heading"
          ref={headingRef}
          tabIndex={-1}
          className="text-[length:var(--fs-24)] font-semibold text-text-strong outline-none"
        >
          워크스페이스 초대를 수락하시겠어요?
        </h1>
        <p className="mt-[var(--s-3)] text-[length:var(--fs-13)] text-text-muted">
          이메일로 받은 초대입니다. 수락하면 워크스페이스에 합류합니다.
        </p>
        <Button
          type="button"
          data-testid="email-invite-accept"
          disabled={busy}
          aria-busy={busy || undefined}
          size="lg"
          className="mt-[var(--s-7)] w-full"
          onClick={() => void onAccept()}
        >
          {busy ? '합류 중…' : '초대 수락'}
        </Button>
        {acceptError ? (
          <p
            data-testid="email-invite-accept-error"
            role="alert"
            aria-live="assertive"
            className="mt-[var(--s-4)] flex items-center justify-center gap-[var(--s-2)] text-[length:var(--fs-13)] text-text-strong"
          >
            {/* S68 a11y (MAJOR-6 / HIGH-1): text-danger 는 라이트 대비 미달이라 미사용.
                색 의존을 해소하는 시각 단서로 ⚠ 아이콘(aria-hidden)을 곁들인다. */}
            <Icon name="alert" size="sm" className="shrink-0" />
            <span>{acceptError}</span>
          </p>
        ) : null}
      </section>
    </main>
  );
}
