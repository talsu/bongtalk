import { useMemo, useState } from 'react';
import {
  EMAIL_INVITE_MAX_BATCH,
  type EmailInviteResultRow,
  type EmailInviteRole,
} from '@qufox/shared-types';
import { Button, Icon } from '../../design-system/primitives';
import { useInviteByEmail } from './useEmailInvites';

/**
 * S68 (D13 / FR-W04): 이메일 직접 초대 — 최대 50개 주소 입력 + 역할(MEMBER/GUEST) 선택 +
 * 부분성공 결과 표시. 미가입은 보류 초대(메일 발송), 이미 가입은 즉시 멤버 추가된다.
 * ADMIN 이상만 노출(서버 @Roles('ADMIN') 권위).
 */
const OUTCOME_LABEL: Record<EmailInviteResultRow['outcome'], string> = {
  ADDED_MEMBER: '바로 합류',
  PENDING: '초대 메일 발송',
  ALREADY_MEMBER: '이미 멤버',
  ALREADY_PENDING: '이미 초대됨',
  FAILED: '실패',
};

// 한 줄/콤마/공백/세미콜론 구분 입력을 이메일 배열로 분해한다.
function parseEmails(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[\s,;]+/)
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e.length > 0),
    ),
  ];
}

export function EmailInvitePanel({ workspaceId }: { workspaceId: string }): JSX.Element {
  const invite = useInviteByEmail(workspaceId);
  const [raw, setRaw] = useState('');
  const [role, setRole] = useState<EmailInviteRole>('MEMBER');
  const [results, setResults] = useState<EmailInviteResultRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const emails = useMemo(() => parseEmails(raw), [raw]);
  const tooMany = emails.length > EMAIL_INVITE_MAX_BATCH;
  const canSubmit = emails.length > 0 && !tooMany && !invite.isPending;
  // S68 a11y (HIGH-2): SR 요약(완료/실패) 산정에 쓴다.
  const failedResultCount = useMemo(
    () => (results ?? []).filter((r) => r.outcome === 'FAILED').length,
    [results],
  );

  const onSubmit = async (): Promise<void> => {
    setErr(null);
    setResults(null);
    try {
      const res = await invite.mutateAsync({ emails, role });
      setResults(res.results);
      setRaw('');
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div data-testid="email-invite-panel" className="flex flex-col gap-[var(--s-4)]">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-[length:var(--fs-15)]">이메일로 초대</h3>
      </div>
      <p className="text-[length:var(--fs-13)] text-text-muted">
        한 번에 최대 {EMAIL_INVITE_MAX_BATCH}개의 이메일을 초대할 수 있습니다. 쉼표·줄바꿈·공백으로
        구분하세요. 이미 가입한 사용자는 즉시 합류하고, 미가입자에게는 안내 메일이 발송됩니다.
      </p>

      <div className="qf-field">
        <label className="qf-field__label" htmlFor="email-invite-input">
          이메일 주소{' '}
          {/* S68 a11y/ui (HIGH-5): text-danger 는 라이트 대비 미달이라 카운트 색 의존을
              해소한다(테마안전 text-text-strong + ⚠ 아이콘). 정상 카운트는 muted. */}
          {tooMany ? (
            <span className="inline-flex items-center gap-[var(--s-1)] text-text-strong">
              <Icon name="alert" size="sm" className="shrink-0" />({emails.length}/
              {EMAIL_INVITE_MAX_BATCH})
            </span>
          ) : (
            <span className="text-text-muted">
              ({emails.length}/{EMAIL_INVITE_MAX_BATCH})
            </span>
          )}
        </label>
        <textarea
          id="email-invite-input"
          data-testid="email-invite-input"
          rows={4}
          // S68 ui (MEDIUM-2): qf-input 단독은 height 40px 가 강제돼 rows 가 무시된다.
          // qf-textarea 를 더해 멀티라인 높이를 살린다.
          className="qf-input qf-textarea"
          placeholder="alice@example.com, bob@example.com"
          value={raw}
          // S68 a11y (MAJOR-1): 한도 초과 시 aria-invalid + 오류 메시지 연결.
          aria-invalid={tooMany || undefined}
          aria-describedby={tooMany ? 'email-invite-too-many' : undefined}
          onChange={(e) => setRaw(e.target.value)}
        />
        {tooMany ? (
          <p
            id="email-invite-too-many"
            className="qf-field__error"
            role="alert"
            data-testid="email-invite-too-many"
          >
            최대 {EMAIL_INVITE_MAX_BATCH}개까지 한 번에 초대할 수 있습니다.
          </p>
        ) : null}
      </div>

      <div className="qf-field">
        <label className="qf-field__label" htmlFor="email-invite-role">
          역할
        </label>
        <select
          id="email-invite-role"
          data-testid="email-invite-role"
          className="qf-input"
          value={role}
          onChange={(e) => setRole(e.target.value as EmailInviteRole)}
        >
          <option value="MEMBER">멤버 (MEMBER)</option>
          <option value="GUEST">게스트 (GUEST)</option>
        </select>
      </div>

      <div>
        <Button
          data-testid="email-invite-submit"
          onClick={() => void onSubmit()}
          disabled={!canSubmit}
          aria-busy={invite.isPending || undefined}
        >
          {invite.isPending ? '초대 중…' : '초대 보내기'}
        </Button>
      </div>

      {err ? (
        <p className="qf-field__error" role="alert" data-testid="email-invite-error">
          {err}
        </p>
      ) : null}

      {results ? (
        <div
          data-testid="email-invite-results"
          // S68 a11y (HIGH-2): 결과 컨테이너를 라이브 status 영역으로 보강(role=status +
          // aria-atomic 으로 전체를 한 번에 읽게 한다). aria-live 는 status 가 함의한다.
          role="status"
          aria-atomic="true"
          className="flex flex-col gap-[var(--s-2)]"
        >
          {/* S68 a11y (HIGH-2): SR 용 요약 — 완료/실패 건수를 한 줄로 먼저 읽어준다. */}
          <span className="sr-only">
            {results.length}건 처리: {results.length - failedResultCount}건 완료,{' '}
            {failedResultCount}건 실패.
          </span>
          <h4 className="font-semibold text-[length:var(--fs-13)]">초대 결과</h4>
          <ul className="flex flex-col gap-[var(--s-1)]">
            {results.map((r) => {
              const failed = r.outcome === 'FAILED';
              return (
                <li
                  key={r.email}
                  data-testid="email-invite-result-row"
                  data-outcome={r.outcome}
                  className="flex items-center justify-between gap-[var(--s-3)] rounded-sm border border-border-subtle bg-bg-surface px-[var(--s-3)] py-[var(--s-2)] text-[length:var(--fs-13)]"
                >
                  <span className="text-foreground">{r.email}</span>
                  {/* S68 a11y/ui (HIGH-5 + HIGH-1): FAILED 도 text-danger(라이트 대비 미달)
                      대신 테마안전 text-text-strong + ⚠ 아이콘으로 표시한다. 실패 상세는
                      title 외에 sr-only 로도 노출해 스크린리더에 전달한다(HIGH-1). */}
                  <span
                    className={
                      failed
                        ? 'inline-flex items-center gap-[var(--s-1)] text-text-strong text-[length:var(--fs-12)]'
                        : 'text-text-muted text-[length:var(--fs-12)]'
                    }
                    title={r.error}
                  >
                    {failed ? <Icon name="alert" size="sm" className="shrink-0" /> : null}
                    {OUTCOME_LABEL[r.outcome]}
                    {failed && r.error ? <span className="sr-only">: {r.error}</span> : null}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
