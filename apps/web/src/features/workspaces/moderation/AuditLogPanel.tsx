import { useMemo, useState } from 'react';
import { AUDIT_ACTION_LABELS, type AuditLogEntry } from '@qufox/shared-types';
import { Button } from '../../../design-system/primitives';
import { useAuditLogs } from '../useModeration';

/**
 * S64 (D12 / FR-RM12): 감사 로그 조회 패널(워크스페이스 설정 audit-log 탭).
 *
 * VIEW_AUDIT_LOG(ADMIN+) 게이트는 서버가 강제하고, 이 패널은 ADMIN+ 만 노출되는 탭에서
 * 렌더한다. cursor 무한 스크롤(더 보기) + action 필터. DS qf-* + 토큰만 사용(raw hex/px
 * 금지). a11y: 목록은 role=list, 행은 role=listitem, action 필터는 라벨된 select.
 */
export function AuditLogPanel({ workspaceId }: { workspaceId: string }): JSX.Element {
  const [action, setAction] = useState<string>('');
  const query = useAuditLogs(workspaceId, { action: action || undefined });

  const entries = useMemo<AuditLogEntry[]>(
    () => (query.data?.pages ?? []).flatMap((p) => p.entries),
    [query.data],
  );

  // action 필터 옵션은 라벨 맵 키에서 만든다(미지정 키는 raw 표시).
  const actionOptions = Object.keys(AUDIT_ACTION_LABELS);

  return (
    <div className="flex flex-col gap-[var(--s-4)]" data-testid="audit-log-panel">
      <div className="flex items-center gap-[var(--s-3)]">
        <label
          className="text-[length:var(--fs-13)] text-text-secondary"
          htmlFor="audit-action-filter"
        >
          액션 필터
        </label>
        <select
          id="audit-action-filter"
          data-testid="audit-action-filter"
          className="qf-input max-w-xs"
          value={action}
          onChange={(e) => setAction(e.target.value)}
        >
          <option value="">전체</option>
          {actionOptions.map((a) => (
            <option key={a} value={a}>
              {AUDIT_ACTION_LABELS[a]}
            </option>
          ))}
        </select>
      </div>

      {query.isLoading ? (
        <p
          className="text-[length:var(--fs-13)] text-text-muted"
          data-testid="audit-log-loading"
          role="status"
          aria-live="polite"
        >
          불러오는 중…
        </p>
      ) : query.isError ? (
        <p className="qf-field__error" data-testid="audit-log-error" role="alert">
          감사 로그를 불러오지 못했습니다.
        </p>
      ) : entries.length === 0 ? (
        <p className="text-[length:var(--fs-13)] text-text-muted" data-testid="audit-log-empty">
          기록된 감사 로그가 없습니다.
        </p>
      ) : (
        <ul
          role="list"
          aria-label="감사 로그 목록"
          className="flex flex-col gap-[var(--s-1)]"
          data-testid="audit-log-list"
        >
          {entries.map((e) => (
            <AuditRow key={e.id} entry={e} />
          ))}
        </ul>
      )}

      {query.hasNextPage ? (
        <Button
          variant="ghost"
          data-testid="audit-log-load-more"
          disabled={query.isFetchingNextPage}
          aria-label="감사 로그 더 보기"
          aria-busy={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? '불러오는 중…' : '더 보기'}
        </Button>
      ) : null}
    </div>
  );
}

function AuditRow({ entry }: { entry: AuditLogEntry }): JSX.Element {
  const label = AUDIT_ACTION_LABELS[entry.action] ?? entry.action;
  const when = formatAuditTime(entry.createdAt);
  const actorName = entry.actor?.username ?? '(알 수 없는 사용자)';
  // 072 백로그 S-G (FR-RM12): 5열(시각·실행자·액션·대상·사유). 대상은 서버가 사용자면
  // username 을 해석해 내려준다(target). 아니면 targetId 축약 폴백. 사유는 별도 행.
  const targetName = entry.target?.username ?? null;
  const targetDisplay = targetName ?? (entry.targetId ? entry.targetId.slice(0, 8) : null);
  const reason = entry.reason ?? null;
  return (
    <li
      role="listitem"
      data-testid="audit-log-row"
      className="flex items-start justify-between gap-[var(--s-3)] rounded-[var(--r-sm)] bg-bg-subtle px-[var(--s-3)] py-[var(--s-2)]"
    >
      <div className="min-w-0 flex flex-col gap-[var(--s-1)]">
        <span className="text-[length:var(--fs-13)] text-text-strong">{label}</span>
        <span className="text-[length:var(--fs-12)] text-text-muted truncate">
          <span data-testid="audit-log-actor">{actorName}</span>
          {targetDisplay ? (
            <span
              data-testid="audit-log-target"
              // target username 이 없으면(비-사용자 대상) 축약 id 가 시각만 의미하므로
              // aria-label 로 전체 식별자를 명시한다(S64 a11y M-02 패턴 유지).
              aria-label={targetName ? `대상: ${targetName}` : `대상: ${entry.targetId}`}
            >
              {' → '}
              {targetName ? `@${targetName}` : targetDisplay}
            </span>
          ) : null}
        </span>
        {reason ? (
          <span
            data-testid="audit-log-reason"
            className="text-[length:var(--fs-12)] text-text-muted truncate"
          >
            사유: {reason}
          </span>
        ) : null}
      </div>
      <time
        dateTime={entry.createdAt}
        className="shrink-0 text-[length:var(--fs-12)] text-text-muted"
      >
        {when}
      </time>
    </li>
  );
}

function formatAuditTime(iso: string): string {
  try {
    return new Intl.DateTimeFormat('ko-KR', {
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}
