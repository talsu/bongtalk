import { useState } from 'react';
import type { ProcessApplicationAction, WorkspaceMemberApplication } from '@qufox/shared-types';
import { Button, Dialog, Icon } from '../../design-system/primitives';
import { useNotifications } from '../../stores/notification-store';
import { useApplications, useProcessApplication } from './useApplications';

type Props = {
  /** 신청 API 라우팅 키(slug). */
  slug: string;
  /** ADMIN 권한자에게만 신청 목록을 노출한다(서버가 최종 권위 — approve/interview ADMIN+). */
  enabled: boolean;
  /** reject 만 가능한 MODERATOR 면 approve/interview 버튼을 숨긴다(서버도 403). */
  canApprove: boolean;
  /**
   * a11y M-1(minor): 섹션 제목 heading level(주변 문서 구조에 맞춤). 기본 h3.
   * 4 면 h4 로 렌더한다.
   */
  headingLevel?: 3 | 4;
};

/**
 * S70 (D13 / FR-W06): 가입 신청 리뷰 패널(ADMIN+). PENDING/INTERVIEW 신청을 approve /
 * reject(reviewNote) / interview 처리한다. reject 사유 입력 + approve/interview 버튼은
 * canApprove(ADMIN+)에게만 노출한다(MODERATOR 는 reject 만).
 *
 * a11y: 섹션 제목을 section 에 aria-labelledby 로 연결(M-3), 처리 결과를 sr-only 라이브
 * 영역으로 알림(H-4), 거절은 되돌릴 수 없으므로 alertdialog 로 확인(H-6).
 */
export function ApplicationReviewPanel({
  slug,
  enabled,
  canApprove,
  headingLevel = 3,
}: Props): JSX.Element | null {
  const { data, isLoading } = useApplications(slug, 'PENDING', enabled);
  const interviews = useApplications(slug, 'INTERVIEW', enabled);
  const processMut = useProcessApplication(slug);
  const notify = useNotifications((s) => s.push);
  const [noteByApp, setNoteByApp] = useState<Record<string, string>>({});
  // a11y H-4: 처리 결과를 sr-only 라이브 영역에 싣는다(스크린리더 안내).
  const [liveMessage, setLiveMessage] = useState('');
  // a11y H-6: 거절 확인 alertdialog 대상.
  const [confirmRejectApp, setConfirmRejectApp] = useState<WorkspaceMemberApplication | null>(null);

  if (!enabled) return null;

  const rows: WorkspaceMemberApplication[] = [
    ...(data?.applications ?? []),
    ...(interviews.data?.applications ?? []),
  ];

  const act = async (
    app: WorkspaceMemberApplication,
    action: ProcessApplicationAction,
  ): Promise<void> => {
    const name = app.applicant?.username ?? app.applicantId;
    try {
      await processMut.mutateAsync({
        applicationId: app.id,
        action,
        reviewNote: action === 'reject' ? noteByApp[app.id] : undefined,
      });
      const verb = action === 'approve' ? '승인' : action === 'reject' ? '거절' : '인터뷰 전환';
      notify({ variant: 'success', title: `${name} 님 신청을 ${verb}했습니다` });
      setLiveMessage(`${name} 님 신청을 ${verb}했습니다.`);
    } catch {
      notify({ variant: 'danger', title: '신청 처리에 실패했습니다' });
      setLiveMessage('신청 처리에 실패했습니다.');
    }
  };

  const headingId = 'application-review-heading';
  const heading =
    headingLevel === 4 ? (
      <h4
        id={headingId}
        className="mb-[var(--s-2)] text-[length:var(--fs-11)] font-semibold uppercase text-text-muted"
      >
        가입 신청
      </h4>
    ) : (
      <h3
        id={headingId}
        className="mb-[var(--s-2)] text-[length:var(--fs-11)] font-semibold uppercase text-text-muted"
      >
        가입 신청
      </h3>
    );

  return (
    <section
      data-testid="application-review-panel"
      className="mt-[var(--s-4)]"
      // a11y M-3: 섹션을 제목으로 라벨링한다.
      aria-labelledby={headingId}
    >
      {heading}
      {/* a11y H-4: 처리 결과 라이브 영역(시각적 숨김). */}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {liveMessage}
      </div>
      {/* a11y M-4: PENDING + INTERVIEW 둘 중 하나라도 로딩이면 busy. */}
      {isLoading || interviews.isLoading ? (
        <p role="status" aria-busy="true" className="text-[length:var(--fs-13)] text-text-muted">
          불러오는 중…
        </p>
      ) : rows.length === 0 ? (
        <p
          data-testid="application-list-empty"
          className="text-[length:var(--fs-13)] text-text-muted"
        >
          대기 중인 가입 신청이 없습니다.
        </p>
      ) : (
        <ul aria-label="가입 신청 목록" className="text-[length:var(--fs-13)]">
          {rows.map((app) => {
            const name = app.applicant?.username ?? app.applicantId;
            const isInterview = app.status === 'INTERVIEW';
            return (
              <li
                key={app.id}
                data-testid={`application-row-${app.id}`}
                className="flex flex-col gap-[var(--s-2)] border-b border-border-subtle py-[var(--s-3)]"
              >
                <div className="flex items-center justify-between gap-[var(--s-2)]">
                  <span className="min-w-0 truncate text-text-strong">{name}</span>
                  {isInterview ? (
                    <span className="flex items-center gap-[var(--s-1)] text-text-muted">
                      <Icon name="message" aria-hidden />
                      인터뷰 진행 중
                    </span>
                  ) : null}
                </div>
                {app.answers.length > 0 ? (
                  <dl className="text-text-secondary">
                    {app.answers.map((a, i) => (
                      <div key={`${app.id}-${i}`} className="flex gap-[var(--s-2)]">
                        {/* a11y H-5: questionId 원문 노출 대신 "질문 N" aria-label(질문
                            카탈로그 OnboardingQuestion 은 S71/S72 carryover). */}
                        <dt className="shrink-0 text-text-muted" aria-label={`질문 ${i + 1}`}>
                          {a.questionId}
                        </dt>
                        <dd className="min-w-0 break-words">{a.answer}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
                {canApprove ? (
                  <label className="flex flex-col gap-[var(--s-1)]">
                    <span className="text-text-muted">거절 사유(선택)</span>
                    <textarea
                      data-testid={`application-note-${app.id}`}
                      className="qf-input qf-textarea"
                      rows={2}
                      maxLength={500}
                      value={noteByApp[app.id] ?? ''}
                      onChange={(e) =>
                        setNoteByApp((prev) => ({ ...prev, [app.id]: e.target.value }))
                      }
                    />
                  </label>
                ) : null}
                <div className="flex flex-wrap gap-[var(--s-2)]">
                  {canApprove ? (
                    <Button
                      variant="primary"
                      size="sm"
                      data-testid={`application-approve-${app.id}`}
                      aria-label={`${name} 님 신청 승인`}
                      disabled={processMut.isPending}
                      onClick={() => void act(app, 'approve')}
                    >
                      승인
                    </Button>
                  ) : null}
                  <Button
                    // ui MEDIUM: 거절은 파괴적 액션이므로 danger 변형.
                    variant="danger"
                    size="sm"
                    data-testid={`application-reject-${app.id}`}
                    aria-label={`${name} 님 신청 거절`}
                    disabled={processMut.isPending}
                    // a11y H-6: 되돌릴 수 없으므로 확인 alertdialog 를 연다.
                    onClick={() => setConfirmRejectApp(app)}
                  >
                    거절
                  </Button>
                  {canApprove && !isInterview ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      data-testid={`application-interview-${app.id}`}
                      aria-label={`${name} 님 인터뷰 전환`}
                      disabled={processMut.isPending}
                      onClick={() => void act(app, 'interview')}
                    >
                      인터뷰
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* a11y H-6: 거절 확인. 되돌릴 수 없음을 알리고(alertDialog · aria-labelledby/
          describedby/Esc 는 Dialog 가 처리), 확인 시에만 reject 를 실행한다. */}
      <Dialog
        open={confirmRejectApp !== null}
        onOpenChange={(o) => {
          if (!o) setConfirmRejectApp(null);
        }}
        alertDialog
        title="가입 신청을 거절할까요?"
        description="거절하면 신청자는 24시간이 지난 후에야 다시 신청할 수 있습니다. 이 작업은 되돌릴 수 없습니다."
      >
        <div className="flex justify-end gap-[var(--s-2)]">
          <Button
            variant="secondary"
            size="sm"
            data-testid="application-reject-cancel"
            onClick={() => setConfirmRejectApp(null)}
          >
            취소
          </Button>
          <Button
            variant="danger"
            size="sm"
            data-testid="application-reject-confirm"
            disabled={processMut.isPending}
            onClick={() => {
              const target = confirmRejectApp;
              setConfirmRejectApp(null);
              if (target) void act(target, 'reject');
            }}
          >
            거절
          </Button>
        </div>
      </Dialog>
    </section>
  );
}
