import { useMemo, useState } from 'react';
import { EMAIL_DOMAINS_MAX, isOverlyBroadDomain } from '@qufox/shared-types';
import { Button, Icon, Input } from '../../design-system/primitives';
import { useUpdateWorkspace } from './useWorkspaces';

/**
 * S68 (D13 / FR-W05): 이메일 도메인 화이트리스트 관리 — OWNER 만 추가/삭제. exact match
 * (소문자 정규화). 빈 목록 = 제한 없음. emailDomains 는 기존 PATCH /workspaces/:id 로
 * 보낸다(Fork C — 전용 엔드포인트 없음). 서버 OWNER 게이트가 최종 권위다.
 *
 * S66 MEDIUM-2 이월: `.co.uk`/`com` 같은 TLD 수준 입력은 워크스페이스를 사실상 개방하므로
 * 경고 배너를 띄운다(exact match 라 동작 자체는 정상 — 정규식 제한은 하지 않고 안내만).
 * S68 fix-forward (reviewer MN2): 다중레이블 판별(isOverlyBroadDomain)은 @qufox/shared-types
 * 단일 출처에서 import 한다(BE 와 동일 로직 — contract 원칙).
 */

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export function EmailDomainsPanel({
  workspaceId,
  initialDomains,
  canEdit,
}: {
  workspaceId: string;
  initialDomains: string[];
  // OWNER 만 편집 가능(서버 게이트가 최종 권위). false 면 읽기 전용 + 안내.
  canEdit: boolean;
}): JSX.Element {
  const update = useUpdateWorkspace(workspaceId);
  const [domains, setDomains] = useState<string[]>(initialDomains);
  const [draft, setDraft] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const broadDomains = useMemo(() => domains.filter((d) => isOverlyBroadDomain(d)), [domains]);

  const addDomain = (): void => {
    setErr(null);
    const value = draft.trim().toLowerCase();
    if (value.length === 0) return;
    if (!DOMAIN_RE.test(value)) {
      setErr('example.com 형태의 소문자 도메인만 추가할 수 있습니다.');
      return;
    }
    if (domains.includes(value)) {
      setDraft('');
      return;
    }
    if (domains.length >= EMAIL_DOMAINS_MAX) {
      setErr(`도메인은 최대 ${EMAIL_DOMAINS_MAX}개까지 추가할 수 있습니다.`);
      return;
    }
    setDomains([...domains, value]);
    setDraft('');
  };

  const removeDomain = (value: string): void => {
    setDomains(domains.filter((d) => d !== value));
  };

  const onSave = async (): Promise<void> => {
    setErr(null);
    try {
      await update.mutateAsync({ emailDomains: domains });
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const dirty = useMemo(() => {
    if (domains.length !== initialDomains.length) return true;
    const a = [...domains].sort();
    const b = [...initialDomains].sort();
    return a.some((d, i) => d !== b[i]);
  }, [domains, initialDomains]);

  return (
    <section
      data-testid="email-domains-panel"
      aria-labelledby="email-domains-heading"
      className="flex flex-col gap-[var(--s-3)]"
    >
      <h3 id="email-domains-heading" className="font-semibold text-[length:var(--fs-15)]">
        이메일 도메인 화이트리스트
      </h3>
      <p className="text-[length:var(--fs-13)] text-text-muted">
        등록한 도메인의 인증된 이메일 사용자는 별도 초대 없이 바로 가입할 수 있습니다. 도메인이
        없으면 제한이 없습니다(누구나 초대로 가입). OWNER만 변경할 수 있습니다.
      </p>

      {!canEdit ? (
        <div
          data-testid="email-domains-owner-note"
          role="note"
          className="text-[length:var(--fs-13)] text-text-muted"
        >
          OWNER만 도메인을 변경할 수 있습니다.
        </div>
      ) : null}

      {broadDomains.length > 0 ? (
        <div
          data-testid="email-domains-broad-warning"
          role="alert"
          className="flex items-start gap-[var(--s-2)] rounded-sm border border-border-subtle bg-bg-subtle px-[var(--s-3)] py-[var(--s-2)] text-[length:var(--fs-12)] text-text-strong"
        >
          {/* S68 a11y (HIGH-5): 색 의존을 해소하는 시각 단서(아이콘은 aria-hidden — role=alert
              텍스트가 SR 에 충분). text-danger 는 라이트 대비 미달이라 text-text-strong 사용. */}
          <Icon name="alert" size="sm" className="mt-[var(--s-1)] shrink-0" />
          <span>
            {broadDomains.join(', ')} 도메인은 범위가 너무 넓습니다. 해당 도메인의 모든 이메일
            사용자가 가입할 수 있으니 의도한 것인지 확인하세요.
          </span>
        </div>
      ) : null}

      <ul className="flex flex-col gap-[var(--s-1)]">
        {domains.length === 0 ? (
          <li
            data-testid="email-domains-empty"
            className="text-[length:var(--fs-13)] text-text-muted"
          >
            등록된 도메인이 없습니다.
          </li>
        ) : (
          domains.map((d) => (
            <li
              key={d}
              data-testid="email-domain-row"
              className="flex items-center justify-between gap-[var(--s-3)] rounded-sm border border-border-subtle bg-bg-surface px-[var(--s-3)] py-[var(--s-2)] text-[length:var(--fs-13)]"
            >
              <span className="font-mono text-foreground">{d}</span>
              {canEdit ? (
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="email-domain-remove"
                  aria-label={`${d} 도메인 삭제`}
                  onClick={() => removeDomain(d)}
                >
                  삭제
                </Button>
              ) : null}
            </li>
          ))
        )}
      </ul>

      {canEdit ? (
        <>
          <div className="flex gap-[var(--s-2)] items-end">
            <div className="qf-field flex-1">
              <label className="qf-field__label" htmlFor="email-domain-input">
                도메인 추가
              </label>
              <Input
                id="email-domain-input"
                data-testid="email-domain-input"
                placeholder="example.com"
                invalid={!!err}
                aria-describedby={err ? 'email-domains-error' : undefined}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addDomain();
                  }
                }}
              />
            </div>
            <Button data-testid="email-domain-add" variant="ghost" onClick={addDomain}>
              추가
            </Button>
          </div>

          {err ? (
            <p
              id="email-domains-error"
              className="qf-field__error"
              role="alert"
              data-testid="email-domains-error"
            >
              {err}
            </p>
          ) : null}

          <div>
            <Button
              data-testid="email-domains-save"
              onClick={() => void onSave()}
              disabled={!dirty || update.isPending}
              aria-busy={update.isPending || undefined}
            >
              {update.isPending ? '저장 중…' : '저장'}
            </Button>
          </div>
        </>
      ) : null}
    </section>
  );
}
