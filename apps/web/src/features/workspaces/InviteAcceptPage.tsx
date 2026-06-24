import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Button } from '../../design-system/primitives';
import { useAcceptInvite, useInvitePreview } from './useWorkspaces';
import { useAuth } from '../auth/AuthProvider';
import { InviteExpired } from './InviteExpired';

// S66 (D13 / FR-W21): 만료·비활성·횟수초과 초대 → 전용 화면으로 분기할 errorCode 집합.
const EXPIRED_INVITE_CODES = new Set(['INVITE_EXPIRED', 'INVITE_EXHAUSTED', 'INVITE_REVOKED']);

// S66 fix-forward (contract-LOW): 초대 수락 시 403 진입 게이트 사유별 안내 문구. 일반
// "사용 불가" 대신 미인증/도메인 제한을 명시해 사용자가 다음 행동(인증 완료/올바른 계정)을
// 알 수 있게 한다.
const ACCEPT_FORBIDDEN_MESSAGES: Record<string, string> = {
  EMAIL_NOT_VERIFIED: '이메일 인증 후 초대를 수락할 수 있습니다.',
  WORKSPACE_DOMAIN_NOT_ALLOWED: '허용된 이메일 도메인만 참여할 수 있습니다.',
};

const CARD_STYLE = {
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-xl)',
  boxShadow: 'var(--elev-2)',
} as const;

export function InviteAcceptPage(): JSX.Element {
  const { code } = useParams();
  const navigate = useNavigate();
  const { status } = useAuth();
  const { data: preview, isLoading, error } = useInvitePreview(code);
  const acceptMut = useAcceptInvite();
  // S66 fix-forward (contract-LOW): 수락 시 403 진입 게이트 사유 안내 문구.
  const [acceptError, setAcceptError] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div
        data-testid="invite-loading"
        className="qf-empty flex min-h-full items-center justify-center"
      >
        <div className="qf-empty__body">초대를 확인하는 중…</div>
      </div>
    );
  }
  if (error || !preview) {
    // S66 (D13 / FR-W21): 만료/비활성/횟수초과(410) → 전용 만료 화면으로 분기한다.
    const code = (error as (Error & { errorCode?: string }) | undefined)?.errorCode;
    if (code && EXPIRED_INVITE_CODES.has(code)) {
      return <InviteExpired />;
    }
    return (
      <main className="flex min-h-full items-center justify-center bg-background p-[var(--s-6)]">
        <section
          data-testid="invite-invalid"
          className="max-w-md p-[var(--s-9)] text-center"
          style={CARD_STYLE}
        >
          <h1 className="text-[length:var(--fs-20)] font-semibold text-warning">
            초대 링크를 사용할 수 없어요
          </h1>
          <p className="mt-[var(--s-3)] text-[length:var(--fs-13)] text-text-muted">
            {(error as Error | undefined)?.message ?? '이 초대는 만료되었거나 유효하지 않습니다.'}
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="flex min-h-full items-center justify-center bg-background p-[var(--s-6)]">
      <section className="w-full max-w-md p-[var(--s-9)] text-center" style={CARD_STYLE}>
        <div className="qf-eyebrow mb-[var(--s-3)]">workspace invite</div>
        <h1
          className="text-[length:var(--fs-24)] font-semibold tracking-[var(--tracking-tight)] text-text-strong"
          data-testid="invite-workspace-name"
        >
          {preview.workspace.name} 에 합류
        </h1>
        <p className="mt-[var(--s-3)] text-[length:var(--fs-13)] text-text-muted">
          <span className="font-mono text-[length:var(--fs-12)]">@{preview.workspace.slug}</span>{' '}
          워크스페이스에 초대되었어요.
          {preview.usesRemaining !== null && <> 남은 자리 {preview.usesRemaining}개.</>}
        </p>
        {status === 'anonymous' ? (
          <div className="mt-[var(--s-7)] flex flex-col gap-[var(--s-3)] text-[length:var(--fs-13)]">
            <Link to={`/login?from=/invite/${code}`} className="qf-btn qf-btn--primary qf-btn--lg">
              로그인하고 합류
            </Link>
            <Link to={`/signup?from=/invite/${code}`} className="qf-btn qf-btn--link">
              또는 계정 만들기
            </Link>
          </div>
        ) : (
          <>
            <Button
              type="button"
              data-testid="invite-accept"
              disabled={acceptMut.isPending}
              aria-busy={acceptMut.isPending}
              size="lg"
              className="mt-[var(--s-7)] w-full"
              onClick={async () => {
                setAcceptError(null);
                try {
                  const res = await acceptMut.mutateAsync(code!);
                  navigate(`/w/${res.workspace.slug}`, { replace: true });
                } catch (e) {
                  // S66 fix-forward (contract-LOW): 403 진입 게이트는 사유별 안내로,
                  // 그 외 오류는 일반 메시지로 분기한다.
                  const ec = (e as Error & { errorCode?: string }).errorCode;
                  setAcceptError(
                    (ec && ACCEPT_FORBIDDEN_MESSAGES[ec]) ??
                      '초대를 수락할 수 없습니다. 잠시 후 다시 시도해 주세요.',
                  );
                }
              }}
            >
              {acceptMut.isPending ? '합류 중…' : '초대 수락'}
            </Button>
            {acceptError && (
              <p
                data-testid="invite-accept-error"
                role="alert"
                aria-live="assertive"
                className="mt-[var(--s-4)] text-[length:var(--fs-13)] text-text-strong"
              >
                {acceptError}
              </p>
            )}
          </>
        )}
      </section>
    </main>
  );
}
