import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';

const CARD_STYLE = {
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-xl)',
  boxShadow: 'var(--elev-2)',
} as const;

/**
 * S66 (D13 / FR-W21): 만료·비활성·횟수초과 초대 링크 전용 오류 화면. 서버가 410
 * (INVITE_EXPIRED/INVITE_EXHAUSTED/INVITE_REVOKED)을 반환하면 InviteAcceptPage 가 이
 * 컴포넌트로 분기한다. 워크스페이스명은 미리보기 가능 시에만 표기하고, 홈 이동 버튼을
 * 제공한다.
 *
 * S66 fix-forward (a11y/ui):
 * - (ui-MEDIUM) 오류 색상 text-warning → text-text-strong(고대비, 색의존 해소).
 * - (B3) 진입 시 h1 으로 포커스. (B5) 장식 eyebrow aria-hidden.
 * - (C1) section aria-labelledby. (C3) document.title.
 */
export function InviteExpired({ workspaceName }: { workspaceName?: string }): JSX.Element {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    document.title = '초대 만료 | qufox';
    headingRef.current?.focus();
  }, []);

  return (
    <main className="flex min-h-full items-center justify-center bg-background p-[var(--s-6)]">
      <section
        data-testid="invite-expired"
        aria-labelledby="invite-expired-heading"
        role="alert"
        className="w-full max-w-md p-[var(--s-9)] text-center"
        style={CARD_STYLE}
      >
        <div className="qf-eyebrow mb-[var(--s-3)]" aria-hidden="true">
          workspace invite
        </div>
        <h1
          ref={headingRef}
          id="invite-expired-heading"
          tabIndex={-1}
          className="text-[length:var(--fs-20)] font-semibold text-text-strong"
        >
          초대 링크를 사용할 수 없어요
        </h1>
        <p className="mt-[var(--s-3)] text-[length:var(--fs-13)] text-text-muted">
          초대 링크가 만료되었거나 유효하지 않습니다. 워크스페이스 관리자에게 새 링크를 요청하세요.
        </p>
        {workspaceName && (
          <p className="mt-[var(--s-2)] text-[length:var(--fs-12)] text-text-muted">{workspaceName}</p>
        )}
        <Link
          to="/"
          data-testid="invite-expired-home"
          className="qf-btn qf-btn--primary qf-btn--lg mt-[var(--s-7)] inline-flex w-full justify-center"
        >
          홈으로 이동
        </Link>
      </section>
    </main>
  );
}
