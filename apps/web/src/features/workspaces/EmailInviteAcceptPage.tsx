import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Button } from '../../design-system/primitives';
import { useAuth } from '../auth/AuthProvider';
import { acceptEmailInvite, acceptEmailInviteByOpaque, exchangeEmailInviteToken } from './api';
import { InviteExpired } from './InviteExpired';

/**
 * S68 (D13 / FR-W04a): 이메일 직접 초대 수락 4분기.
 *   ① 미가입 → exchange 로 rawToken 을 opaque 코드로 교환 → 회원가입 리다이렉트(URL 엔
 *      opaque 코드만) → 가입 후 opaque 검증으로 자동 수락.
 *   ② 가입 + 이메일 일치 로그인 → 즉시 수락.
 *   ③ 가입 + 다른 계정 로그인 → 계정 확인 안내(다른 계정/로그아웃 권고).
 *   ④ 토큰 만료/무효 → 410 → 만료 화면.
 *
 * 보안(★핵심 AC): rawToken 은 바디로만 전송하고, 미가입 분기는 opaque 코드로 교환한 뒤
 * 회원가입 URL 엔 opaque 코드만 둔다(rawToken URL/로그 평문 미노출).
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
  | { kind: 'other-account'; inviteEmail: string } // ③ 다른 계정 안내
  | { kind: 'expired' } // ④
  | { kind: 'error'; message: string };

export function EmailInviteAcceptPage(): JSX.Element {
  const { slug, token } = useParams();
  const [searchParams] = useSearchParams();
  // 가입 직후 자동 수락 흐름: /w/:slug/email-invite?opaque=<code>
  const opaque = searchParams.get('opaque');
  const navigate = useNavigate();
  const { status, user } = useAuth();
  const [view, setView] = useState<ViewState>({ kind: 'loading' });
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
        if (EXPIRED_CODES.has(errorCodeOf(e) ?? '')) setView({ kind: 'expired' });
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
      } else if (ec === 'EMAIL_INVITE_TOKEN_INVALID' || ec === 'EMAIL_INVITE_ROLE_MISMATCH') {
        // 이 계정으로는 수락 불가(이메일 불일치/위조) → 다른 계정 안내(분기 ③).
        setView({ kind: 'other-account', inviteEmail: '' });
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
          className="max-w-md p-[var(--s-9)] text-center"
          style={CARD_STYLE}
        >
          <h1 className="text-[length:var(--fs-20)] font-semibold text-warning">
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
          className="w-full max-w-md p-[var(--s-9)] text-center"
          style={CARD_STYLE}
        >
          <h1 className="text-[length:var(--fs-20)] font-semibold text-text-strong">
            다른 계정으로 초대되었습니다
          </h1>
          <p className="mt-[var(--s-3)] text-[length:var(--fs-13)] text-text-muted">
            이 초대는 현재 로그인한 계정({user?.email})이 아닌 다른 이메일로 발송되었습니다.
            초대받은 이메일 계정으로 로그인한 뒤 다시 시도해 주세요.
          </p>
          <div className="mt-[var(--s-7)] flex flex-col gap-[var(--s-3)] text-[length:var(--fs-13)]">
            <Link
              to={`/login?from=${encodeURIComponent(`/w/${slug}/email-invite/${token}`)}`}
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
      <section className="w-full max-w-md p-[var(--s-9)] text-center" style={CARD_STYLE}>
        <div className="qf-eyebrow mb-[var(--s-3)]">workspace invite</div>
        <h1 className="text-[length:var(--fs-24)] font-semibold text-text-strong">
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
            className="mt-[var(--s-4)] text-[length:var(--fs-13)] text-text-strong"
          >
            {acceptError}
          </p>
        ) : null}
      </section>
    </main>
  );
}
