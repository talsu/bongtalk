import { useMemo, useState } from 'react';
import {
  EMAIL_INVITE_MAX_BATCH,
  type EmailInviteResultRow,
  type EmailInviteRole,
} from '@qufox/shared-types';
import { Button } from '../../design-system/primitives';
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
          <span className={tooMany ? 'text-danger' : 'text-text-muted'}>
            ({emails.length}/{EMAIL_INVITE_MAX_BATCH})
          </span>
        </label>
        <textarea
          id="email-invite-input"
          data-testid="email-invite-input"
          rows={4}
          className="qf-input"
          placeholder="alice@example.com, bob@example.com"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
        />
        {tooMany ? (
          <p className="qf-field__error" role="alert" data-testid="email-invite-too-many">
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
          aria-live="polite"
          className="flex flex-col gap-[var(--s-2)]"
        >
          <h4 className="font-semibold text-[length:var(--fs-13)]">초대 결과</h4>
          <ul className="flex flex-col gap-[var(--s-1)]">
            {results.map((r) => (
              <li
                key={r.email}
                data-testid="email-invite-result-row"
                data-outcome={r.outcome}
                className="flex items-center justify-between gap-[var(--s-3)] rounded-sm border border-border-subtle bg-bg-surface px-[var(--s-3)] py-[var(--s-2)] text-[length:var(--fs-13)]"
              >
                <span className="text-foreground">{r.email}</span>
                <span
                  className={
                    r.outcome === 'FAILED'
                      ? 'text-danger text-[length:var(--fs-12)]'
                      : 'text-text-muted text-[length:var(--fs-12)]'
                  }
                  title={r.error}
                >
                  {OUTCOME_LABEL[r.outcome]}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
