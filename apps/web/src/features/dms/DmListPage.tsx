import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Icon, Avatar } from '../../design-system/primitives';
import { useMyWorkspaces, useMembers } from '../workspaces/useWorkspaces';
import { useAuth } from '../auth/AuthProvider';
import { useDmList, useCreateOrGetDm } from './useDms';
import { cn } from '../../lib/cn';

/**
 * task-027-C: desktop /w/:slug/dm — DM list with search + new-DM
 * dialog (workspace members filtered by query).
 */
export function DmListPage(): JSX.Element {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { data: mine } = useMyWorkspaces();
  const ws = useMemo(() => mine?.workspaces.find((w) => w.slug === slug), [mine, slug]);
  const { data: members } = useMembers(ws?.id);
  const { data: dms, isLoading } = useDmList(ws?.id);
  const createDm = useCreateOrGetDm(ws?.id);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);

  const norm = query.trim().toLowerCase();
  const filteredDms = (dms?.items ?? []).filter(
    (d) => !norm || d.otherUsername.toLowerCase().includes(norm),
  );
  const memberCandidates = (members?.members ?? [])
    .filter((m) => m.userId !== user?.id) // task-028-R8 follow: exclude self
    .filter((m) => !norm || m.user.username.toLowerCase().includes(norm));

  const startDm = async (otherUserId: string): Promise<void> => {
    const res = await createDm.mutateAsync({ userId: otherUserId });
    setOpen(false);
    navigate(`/w/${slug}/dm/${otherUserId}?c=${res.channelId}`);
  };

  return (
    <div
      data-testid="dm-list-page"
      className="h-screen flex flex-col"
      style={{ background: 'var(--bg-app)' }}
    >
      <header className="flex items-center gap-[var(--s-3)] px-[var(--s-6)] h-[var(--h-topbar)] border-b border-border-subtle">
        <Icon name="message" size="md" />
        <div className="font-semibold text-[length:var(--fs-16)]">Direct messages</div>
        <div className="ml-auto flex items-center gap-[var(--s-2)]">
          <input
            type="search"
            data-testid="dm-list-search"
            placeholder="검색"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="qf-input"
          />
          <button
            type="button"
            data-testid="dm-new-btn"
            className="qf-btn qf-btn--primary"
            onClick={() => setOpen(true)}
          >
            새 DM
          </button>
        </div>
      </header>
      <main className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="p-[var(--s-6)] text-text-muted">불러오는 중…</div>
        ) : filteredDms.length === 0 ? (
          <div className="qf-empty p-[var(--s-6)]">
            <div className="font-semibold">DM이 아직 없습니다</div>
            <div className="text-text-muted mt-[var(--s-2)]">
              위 “새 DM” 버튼으로 멤버와 대화를 시작하세요.
            </div>
          </div>
        ) : (
          <ul role="list" data-testid="dm-list-items">
            {filteredDms.map((d) => (
              <li key={d.channelId}>
                <button
                  type="button"
                  data-testid={`dm-row-${d.otherUsername}`}
                  onClick={() => navigate(`/w/${slug}/dm/${d.otherUserId}?c=${d.channelId}`)}
                  className={cn(
                    'w-full text-left qf-m-row',
                    d.unreadCount > 0 && 'qf-m-row--unread',
                  )}
                >
                  <Avatar name={d.otherUsername} size="md" />
                  <div className="min-w-0 flex-1">
                    <div className="qf-m-row__primary">{d.otherUsername}</div>
                    <div className="qf-m-row__secondary">
                      {d.lastMessagePreview ?? '대화를 시작하세요'}
                    </div>
                  </div>
                  <div className="qf-m-row__aside">
                    {d.lastMessageAt ? (
                      <span className="qf-m-row__time">{relTime(d.lastMessageAt)}</span>
                    ) : null}
                    {d.unreadCount > 0 ? (
                      <span className="qf-badge qf-badge--count">
                        {d.unreadCount > 99 ? '99+' : d.unreadCount}
                      </span>
                    ) : null}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </main>

      {open ? (
        <div
          data-testid="dm-new-dialog"
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-[var(--z-modal,60)] grid place-items-center"
          style={{ background: 'color-mix(in oklab, var(--bg-app) 60%, transparent)' }}
        >
          <div
            className="bg-bg-subtle rounded-[var(--r-lg)] p-[var(--s-4)] w-[min(480px,92vw)]"
            style={{ boxShadow: 'var(--elev-3)' }}
          >
            <div className="flex items-center gap-[var(--s-2)] mb-[var(--s-3)]">
              <div className="font-semibold">새 DM</div>
              <button
                type="button"
                className="ml-auto"
                data-testid="dm-new-close"
                onClick={() => setOpen(false)}
                aria-label="닫기"
              >
                <Icon name="x" size="sm" />
              </button>
            </div>
            <input
              type="search"
              data-testid="dm-new-search"
              autoFocus
              placeholder="멤버 검색"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="qf-input w-full"
            />
            <ul
              role="list"
              style={{ maxHeight: '300px' }}
              className="mt-[var(--s-3)] overflow-y-auto"
            >
              {memberCandidates.map((m) => (
                <li key={m.userId}>
                  <button
                    type="button"
                    data-testid={`dm-new-candidate-${m.user.username}`}
                    className="w-full text-left qf-m-row"
                    onClick={() => startDm(m.userId)}
                  >
                    <Avatar name={m.user.username} size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="qf-m-row__primary">{m.user.username}</div>
                      <div className="qf-m-row__secondary">{m.role}</div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function relTime(iso: string): string {
  const delta = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(delta / 60_000);
  if (mins < 1) return '방금';
  if (mins < 60) return `${mins}분`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}시간`;
  const days = Math.floor(hours / 24);
  return `${days}일`;
}
