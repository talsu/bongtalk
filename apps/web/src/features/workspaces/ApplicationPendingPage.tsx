import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ApplicationReviewedPayload } from '@qufox/shared-types';
import { Button } from '../../design-system/primitives';
import { useNotifications } from '../../stores/notification-store';
import { useMyApplication, useWithdrawApplication } from './useApplications';

type Props = {
  /** 신청 API 라우팅 키(slug). */
  slug: string;
  /** 워크스페이스 표시명(취소 버튼 aria-label 등). */
  workspaceName?: string;
  /** 승인 시 이동할 워크스페이스 경로(보통 `/w/${slug}`). 미지정 시 `/w/${slug}`. */
  workspacePath?: string;
  /** WS 연결 여부. 끊김(false)이면 useMyApplication 이 30초 polling fallback 으로 전환. */
  wsConnected?: boolean;
};

// FR-W06a: 승인 토스트 후 자동 이동까지의 지연(2초).
const AUTO_NAV_DELAY_MS = 2000;

// S70 fix-forward (ui LOW): S66/S68 진입 플로우 카드 셸 스타일(시각 일관).
const CARD_STYLE = {
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-xl)',
  boxShadow: 'var(--elev-2)',
} as const;

// a11y M-1: 상태별 document.title.
const TITLE_BY_STATUS: Record<string, string> = {
  PENDING: '가입 신청 검토 중 — qufox',
  APPROVED: '가입 승인됨 — qufox',
  REJECTED: '가입 신청 결과 — qufox',
  INTERVIEW: '인터뷰 요청 — qufox',
  WITHDRAWN: '가입 신청 — qufox',
};

/**
 * S70 (D13 / FR-W06·W06a): 가입 신청 대기 화면. 신청 접수 카피 + 취소 버튼을 보여주고,
 * ws:application_reviewed(또는 WS 끊김 시 30초 polling fallback) 결과에 따라 분기한다:
 *   - approved → 토스트 "승인되었습니다" + 2초 후 워크스페이스 자동 이동(Esc 로 취소 가능).
 *   - rejected → 거절 카피 + reviewNote 노출 + '다시 신청하기'(24h cooldown) + '다른 커뮤니티 찾기'.
 *   - interview → 인터뷰 안내(role="alert" — 행동 유도).
 *
 * a11y: 대기/없음은 role="status"(폴라이트), 승인/거절/인터뷰는 role="alert"(어설티브),
 * 진입 시 제목에 포커스 + 상태별 document.title 갱신.
 */
export function ApplicationPendingPage({
  slug,
  workspaceName,
  workspacePath,
  wsConnected = true,
}: Props): JSX.Element {
  const navigate = useNavigate();
  const notify = useNotifications((s) => s.push);
  const { data, isLoading } = useMyApplication(slug, { wsConnected });
  const withdrawMut = useWithdrawApplication(slug);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // WS 이벤트(즉시) 결과를 polling 결과보다 우선해 화면에 반영하기 위한 로컬 상태.
  const [wsReviewed, setWsReviewed] = useState<ApplicationReviewedPayload | null>(null);
  const navTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dest = workspacePath ?? `/w/${slug}`;
  // M1: 본인 신청의 workspaceId(WS 이벤트 가드 기준).
  const application = data?.application ?? null;
  const myWorkspaceId = application?.workspaceId ?? null;

  // 진입 시 포커스(상태별 document.title 는 아래 별도 effect 가 상태와 함께 갱신).
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  // ws:application_reviewed window 이벤트 구독(dispatcher 가 emit). approved 면 2초 후 이동.
  // M1: detail.workspaceId 가 본인 신청 workspaceId 와 일치할 때만 반영한다(타 워크스페이스
  // 승인이 오인 이동을 일으키지 않도록). myWorkspaceId 가 아직 없으면(초기 로드) 보류한다.
  useEffect(() => {
    function onReviewed(e: Event): void {
      const detail = (e as CustomEvent<ApplicationReviewedPayload>).detail;
      if (!detail) return;
      if (myWorkspaceId && detail.workspaceId !== myWorkspaceId) return;
      setWsReviewed(detail);
    }
    window.addEventListener('qufox.application.reviewed', onReviewed);
    return () => {
      window.removeEventListener('qufox.application.reviewed', onReviewed);
      if (navTimer.current) clearTimeout(navTimer.current);
    };
  }, [myWorkspaceId]);

  // 현재 상태: WS 이벤트 우선, 없으면 polling/REST 결과. status 는 대문자(WorkspaceMemberApplication).
  const wireStatus = wsReviewed?.status ?? null;
  const status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'INTERVIEW' | 'WITHDRAWN' | null =
    wireStatus === 'approved'
      ? 'APPROVED'
      : wireStatus === 'rejected'
        ? 'REJECTED'
        : wireStatus === 'interview'
          ? 'INTERVIEW'
          : (application?.status ?? null);
  const reviewNote = wsReviewed?.reviewNote ?? application?.reviewNote ?? null;

  // a11y M-1: 상태별 document.title 갱신.
  useEffect(() => {
    document.title = (status && TITLE_BY_STATUS[status]) ?? '가입 신청 — qufox';
  }, [status]);

  // approved → 토스트 + 2초 후 자동 이동(WS 또는 polling 어느 쪽이든 1회만).
  useEffect(() => {
    if (status !== 'APPROVED') return;
    if (navTimer.current) return;
    notify({ variant: 'success', title: '가입이 승인되었습니다' });
    navTimer.current = setTimeout(() => {
      navigate(dest);
    }, AUTO_NAV_DELAY_MS);
  }, [status, dest, navigate, notify]);

  // a11y H-3: 자동 이동 대기 동안 Esc 로 navTimer 를 취소할 수 있게 한다.
  useEffect(() => {
    if (status !== 'APPROVED') return;
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key !== 'Escape') return;
      if (navTimer.current) {
        clearTimeout(navTimer.current);
        navTimer.current = null;
        notify({ variant: 'info', title: '자동 이동을 취소했습니다' });
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [status, notify]);

  const onWithdraw = async (): Promise<void> => {
    if (!application) return;
    try {
      await withdrawMut.mutateAsync(application.id);
      notify({ variant: 'info', title: '신청을 취소했습니다' });
    } catch {
      notify({ variant: 'danger', title: '신청 취소에 실패했습니다' });
    }
  };

  // a11y M-2(minor): 취소 버튼 라벨에 workspaceName 포함(있으면).
  const cancelLabel = workspaceName ? `${workspaceName} 가입 신청 취소` : '가입 신청 취소';

  return (
    <main
      data-testid="application-pending-page"
      className="flex min-h-full items-center justify-center bg-background p-[var(--s-6)]"
    >
      <section
        className="flex w-full max-w-md flex-col items-center gap-[var(--s-4)] p-[var(--s-9)] text-center"
        style={CARD_STYLE}
      >
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="text-[length:var(--fs-18)] font-semibold text-text-strong"
        >
          가입 신청
        </h1>

        {isLoading && !wsReviewed ? (
          <p role="status" aria-busy="true" className="text-[length:var(--fs-14)] text-text-muted">
            신청 상태를 불러오는 중…
          </p>
        ) : status === 'APPROVED' ? (
          <p
            role="alert"
            data-testid="application-approved"
            className="text-[length:var(--fs-14)] text-text-strong"
          >
            가입이 승인되었습니다. 2초 후 워크스페이스로 이동합니다. 취소하려면 Esc 를 누르세요.
          </p>
        ) : status === 'REJECTED' ? (
          <div
            role="alert"
            data-testid="application-rejected"
            className="flex flex-col gap-[var(--s-3)]"
          >
            <p className="text-[length:var(--fs-14)] text-text-strong">
              아쉽지만 이번 가입 신청은 승인되지 않았습니다.
            </p>
            {reviewNote ? (
              <p
                data-testid="application-review-note"
                className="rounded-md bg-bg-subtle p-[var(--s-3)] text-[length:var(--fs-13)] text-text-secondary"
              >
                {reviewNote}
              </p>
            ) : null}
            <div className="flex justify-center gap-[var(--s-2)]">
              <Button
                variant="primary"
                size="sm"
                data-testid="application-reapply"
                onClick={() => {
                  // REJECTED→재신청 안내. 24h cooldown 은 서버가 강제하므로 폼으로 보낸다.
                  navigate(`/w/${slug}/apply`);
                }}
              >
                다시 신청하기
              </Button>
              <Button
                variant="secondary"
                size="sm"
                data-testid="application-discover"
                onClick={() => navigate('/discover')}
              >
                다른 커뮤니티 찾기
              </Button>
            </div>
          </div>
        ) : status === 'INTERVIEW' ? (
          <p
            role="alert"
            data-testid="application-interview"
            className="text-[length:var(--fs-14)] text-text-strong"
          >
            운영진이 대화를 요청했습니다. 메시지를 확인해 주세요.
          </p>
        ) : status === 'WITHDRAWN' || status === null ? (
          <p
            role="status"
            data-testid="application-none"
            className="text-[length:var(--fs-14)] text-text-muted"
          >
            진행 중인 가입 신청이 없습니다.
          </p>
        ) : (
          <div
            role="status"
            data-testid="application-pending"
            className="flex flex-col gap-[var(--s-3)]"
          >
            <p className="text-[length:var(--fs-14)] text-text-strong">신청이 접수되었습니다.</p>
            <p className="text-[length:var(--fs-13)] text-text-muted">
              운영진이 검토 중입니다. 결과는 이 화면에서 안내됩니다.
            </p>
            <div className="flex justify-center">
              <Button
                variant="secondary"
                size="sm"
                data-testid="application-cancel"
                aria-label={cancelLabel}
                disabled={withdrawMut.isPending}
                onClick={() => void onWithdraw()}
              >
                신청 취소
              </Button>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
