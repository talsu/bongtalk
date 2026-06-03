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
        <p className="text-[length:var(--fs-13)] text-text-muted" data-testid="audit-log-loading">
          불러오는 중…
        </p>
      ) : query.isError ? (
        <p className="qf-field__error" data-testid="audit-log-error">
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
  return (
    <li
      role="listitem"
      data-testid="audit-log-row"
      className="flex items-center justify-between gap-[var(--s-3)] rounded-[var(--r-sm)] bg-bg-subtle px-[var(--s-3)] py-[var(--s-2)]"
    >
      <div className="min-w-0 flex flex-col gap-[var(--s-1)]">
        <span className="text-[length:var(--fs-13)] text-text-strong">{label}</span>
        <span className="text-[length:var(--fs-12)] text-text-muted truncate">
          {actorName}
          {entry.targetId ? ` → ${entry.targetId.slice(0, 8)}` : ''}
        </span>
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
