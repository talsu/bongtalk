import { useCallback, useEffect, useRef, useState } from 'react';
import { EMAIL_VERIFY_RESEND_COOLDOWN_SEC } from '@qufox/shared-types';
import { Button, Icon } from '../../design-system/primitives';
import { BrandMark } from '../../design-system/brand/BrandMark';
import { resendVerificationEmail } from '../../lib/api';
import { useAuth } from './AuthProvider';

const CARD_STYLE = {
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-xl)',
  boxShadow: 'var(--elev-2)',
} as const;

/**
 * S66 (D13 / FR-W05b): 이메일 인증 대기 화면. emailVerified=false 로그인/가입 시 워크
 * 스페이스 진입 대신 렌더된다(App 라우팅의 전역 가드). DS 에 .qf-verify-email-gate 클래스는
 * PRD 목업에만 정의돼 있고 CSS 는 미정의이므로(DS 4파일 수정 금지), 시맨틱 훅으로 클래스만
 * 부여하고 시각 표현은 기존 qf-* + 토큰으로 구성한다. 재발송 60초 쿨다운 카운트다운 +
 * "이미 인증했어요"(/auth/me 재조회) 버튼을 제공한다.
 *
 * S66 fix-forward (a11y):
 * - (A1) notice 는 role=status·aria-live=polite, error 는 role=alert·aria-live=assertive
 *   로 두고 DOM 을 유지해(텍스트만 교체) 전환을 자동 고지한다.
 * - (A2) 재발송 버튼 *이름*에서 카운트다운 숫자를 분리한다. 시각 카운트다운은 버튼 밖
 *   aria-hidden span, 비활성 사유는 aria-label 로만 전달(매초 AT 재고지 방지).
 * - (A3) checking/resending 버튼에 aria-busy.
 * - (B3) 진입 시 h1 으로 포커스. (B4) 재발송 버튼은 aria-disabled + onClick early-return
 *   으로 포커스를 유지하고 사유를 aria-label 로 알린다(HTML disabled 의 포커스 이탈·DS
 *   selector 의존 회피). 일일 한도 소진 시 영구 비활성 + 안내문구.
 * - (B5) 장식 eyebrow 는 aria-hidden. (C1) section aria-labelledby. (C3) document.title.
 * - (D1) 로그인 버튼에 사유 aria-label.
 * - (ui-MEDIUM) 오류 색상 text-warning → text-text-strong(고대비, 색의존 해소).
 */
export function EmailVerificationGate(): JSX.Element {
  const { user, logout, refreshMe } = useAuth();
  const [cooldown, setCooldown] = useState(0);
  const [resending, setResending] = useState(false);
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 일일 재발송 한도 소진 — 버튼을 영구 비활성으로 둔다.
  const [exhausted, setExhausted] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  // (C3) document.title. (B3) 진입 포커스.
  useEffect(() => {
    document.title = '이메일 인증 | qufox';
    headingRef.current?.focus();
  }, []);

  const startCooldown = useCallback((sec: number) => {
    setCooldown(sec);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setCooldown((prev) => {
        if (prev <= 1) {
          if (timerRef.current) clearInterval(timerRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, []);

  const onResend = useCallback(async () => {
    // (B4) aria-disabled 버튼이라 클릭이 들어올 수 있다 — 사유가 있으면 early-return.
    if (cooldown > 0 || resending || exhausted) return;
    setResending(true);
    setError(null);
    setNotice(null);
    try {
      const res = await resendVerificationEmail();
      startCooldown(res.cooldownSec || EMAIL_VERIFY_RESEND_COOLDOWN_SEC);
      if (res.remainingToday <= 0) {
        setExhausted(true);
        setNotice('인증 메일을 다시 보냈습니다. 오늘 재발송 한도에 도달했습니다.');
      } else {
        setNotice('인증 메일을 다시 보냈습니다. 받은 편지함을 확인해 주세요.');
      }
    } catch (e) {
      const err = e as Error & { errorCode?: string; retryAfterSec?: number };
      if (err.errorCode === 'EMAIL_VERIFICATION_RATE_LIMITED') {
        // 쿨다운/일일 한도 — 남은 시간이 있으면 카운트다운을 동기화한다.
        if (typeof err.retryAfterSec === 'number' && err.retryAfterSec > 0) {
          startCooldown(Math.min(err.retryAfterSec, EMAIL_VERIFY_RESEND_COOLDOWN_SEC));
        }
        setError('잠시 후 다시 시도해 주세요. 재발송은 일정 시간 간격으로만 가능합니다.');
      } else {
        setError('인증 메일 재발송에 실패했습니다. 잠시 후 다시 시도해 주세요.');
      }
    } finally {
      setResending(false);
    }
  }, [cooldown, resending, exhausted, startCooldown]);

  const onAlreadyVerified = useCallback(async () => {
    if (checking) return;
    setChecking(true);
    setError(null);
    setNotice(null);
    const verified = await refreshMe();
    setChecking(false);
    if (!verified) {
      setError('아직 인증이 확인되지 않았습니다. 메일의 인증 링크를 클릭한 뒤 다시 시도해 주세요.');
    }
    // verified=true 면 AuthProvider 의 user.emailVerified 가 true 로 바뀌어 전역
    // 가드가 게이트를 해제하고 워크스페이스로 진입한다(별도 네비게이션 불요).
  }, [checking, refreshMe]);

  // (A2/B4) 재발송 버튼의 접근성 사유 — 비활성 원인을 aria-label 로만 전달한다(버튼 이름은
  // 항상 고정 "인증 메일 다시 보내기"). 매초 바뀌는 카운트다운을 이름에 넣지 않아 AT 재고지
  // 폭주를 막는다.
  const resendDisabled = cooldown > 0 || resending || exhausted;
  const resendAriaLabel = exhausted
    ? '인증 메일 다시 보내기 — 오늘 재발송 한도에 도달했습니다'
    : cooldown > 0
      ? `인증 메일 다시 보내기 — ${cooldown}초 후 가능`
      : undefined;

  return (
    <main
      data-testid="verify-email-gate"
      className="qf-verify-email-gate flex min-h-full items-center justify-center bg-background p-[var(--s-6)]"
    >
      <section
        aria-labelledby="verify-gate-heading"
        className="w-full max-w-md p-[var(--s-9)] text-center"
        style={CARD_STYLE}
      >
        <BrandMark variant="wordmark" size={28} className="mb-[var(--s-6)]" />
        {/* (B5) 장식 eyebrow — 대비 미달 토큰이므로 AT 에서 숨긴다. */}
        <div className="qf-eyebrow mb-[var(--s-3)]" aria-hidden="true">
          email verification
        </div>
        <h1
          ref={headingRef}
          id="verify-gate-heading"
          tabIndex={-1}
          className="text-[var(--fs-24)] font-semibold tracking-[var(--tracking-tight)] text-text-strong"
        >
          이메일 인증이 필요합니다
        </h1>
        <p className="mt-[var(--s-3)] text-[var(--fs-13)] text-text-muted">
          인증 메일을 보냈습니다. 받은 편지함을 확인해 주세요.
        </p>
        {user?.email && (
          <p className="mt-[var(--s-2)] text-[var(--fs-12)] text-text-muted">
            <span className="font-mono">{user.email}</span>
          </p>
        )}

        <div className="mt-[var(--s-7)] flex flex-col gap-[var(--s-3)]">
          {/* AUTH-1 (PRD D18 / C-3): 주 동작인 "인증 메일 다시 보내기" 를 primary·첫 번째로,
              보조 동작 "이미 인증했어요" 를 secondary·두 번째로 둔다. */}
          <Button
            type="button"
            data-testid="verify-resend"
            size="lg"
            // (B4) HTML disabled 대신 aria-disabled — 포커스를 유지하고 사유를 aria-label
            // 로 알린다. AUTH-1: 비활성 시각화는 opacity 단독이 아니라 배경/테두리 변화를
            // 동반해 색 단독 의존(WCAG 1.4.1)을 피한다.
            aria-disabled={resendDisabled}
            aria-busy={resending}
            aria-label={resendAriaLabel}
            // AUTH-1 a11y(BLOCKER-1): primary 버튼은 accent 배경 + 흰 텍스트라, 비활성 시
            // 배경을 밝은 bg-subtle 로 바꾸면 흰 텍스트가 묻혀 라이트 테마 대비가 붕괴한다.
            // 배경 swap 대신 opacity 만 낮춘다(배경·텍스트가 함께 페이드 → 상대 대비 보존).
            // 비활성 사유는 색이 아니라 카운트다운 텍스트 + aria-disabled/aria-label 로 전달해
            // 색 단독 의존(1.4.1)을 피한다.
            className={resendDisabled ? 'opacity-60' : undefined}
            onClick={onResend}
          >
            {resending ? '보내는 중…' : '인증 메일 다시 보내기'}
          </Button>
          <Button
            type="button"
            data-testid="verify-already"
            variant="secondary"
            size="lg"
            disabled={checking}
            aria-busy={checking}
            onClick={onAlreadyVerified}
          >
            {checking ? '확인 중…' : '이미 인증했어요'}
          </Button>
          {/* (A2) 시각 카운트다운 — 버튼 밖, AT 에서 숨긴다(매초 재고지 방지). */}
          {cooldown > 0 && (
            <span
              data-testid="verify-resend-countdown"
              aria-hidden="true"
              className="text-[var(--fs-12)] text-text-muted"
            >
              {cooldown}초 후 다시 보낼 수 있습니다
            </span>
          )}
          {exhausted && (
            <span
              data-testid="verify-resend-exhausted"
              className="text-[var(--fs-12)] text-text-muted"
            >
              오늘 재발송 한도에 도달했습니다. 내일 다시 시도해 주세요.
            </span>
          )}
        </div>

        {/* (A1) notice·error 는 항상 DOM 에 존재하는 라이브 영역이다(텍스트만 교체).
            AUTH-1 (PRD D18 + ui/a11y 리뷰 H-1): `.qf-notice` 를 라이브 영역 자체에 두고,
            내용이 있을 때만 __icon + __body 자식을 렌더한다 — 좌측 강조선 + 아이콘으로 색
            단독 의존(WCAG 1.4.1)을 피한다. 비었을 때는 `:empty` → `empty:hidden`(특이도
            우선)으로 display:none 되어 시각적으로 숨고 textContent 는 ''. */}
        <div
          data-testid="verify-notice"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="qf-notice qf-notice--info mt-[var(--s-4)] text-left empty:hidden"
        >
          {notice ? (
            <>
              <span className="qf-notice__icon">
                <Icon name="info" size="sm" aria-hidden />
              </span>
              <span className="qf-notice__body">{notice}</span>
            </>
          ) : null}
        </div>
        <div
          data-testid="verify-error"
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
          className="qf-notice qf-notice--danger mt-[var(--s-4)] text-left empty:hidden"
        >
          {error ? (
            <>
              <span className="qf-notice__icon">
                <Icon name="alert" size="sm" aria-hidden />
              </span>
              <span className="qf-notice__body">{error}</span>
            </>
          ) : null}
        </div>

        {/* AUTH-1 a11y(MED-2 / WCAG 2.5.3 Label in Name): 보이는 텍스트를 그대로
            접근명으로 쓴다(별도 aria-label 제거 — 음성 제어 "다른 계정으로 로그인" 일치). */}
        <button
          type="button"
          data-testid="verify-logout"
          className="qf-btn qf-btn--link mt-[var(--s-6)] text-[var(--fs-13)]"
          onClick={() => void logout()}
        >
          다른 계정으로 로그인
        </button>
      </section>
    </main>
  );
}
