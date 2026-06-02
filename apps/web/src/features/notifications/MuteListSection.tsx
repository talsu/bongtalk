import { useId } from 'react';
import { useMutes, useRemoveChannelMute } from '../channels/useMutes';
import { useServerMutes, useUnmuteServerFromList } from './useNotifLevels';
import { formatMuteRemaining } from './muteRemaining';
import { useNotifications } from '../../stores/notification-store';

/**
 * S49 (D06 / FR-MN-17): "현재 뮤트 중" 섹션 — 뮤트된 채널/서버 목록 + 남은 시간 +
 * 개별 해제.
 *
 *   - 채널 뮤트: GET /me/mutes(보강판 — channelName·workspaceName·mutedUntil).
 *     해제는 DELETE /me/mutes/channels/:channelId(useRemoveChannelMute).
 *   - 서버 뮤트: GET /me/server-mutes. 해제는 DELETE /workspaces/:id/
 *     notification-preferences(useUnmuteServerFromList).
 *
 * a11y(S48 교훈 선반영): 목록 <ul aria-label>·해제 버튼 aria-label=`${name} 뮤트
 * 해제`·남은시간 <time dateTime>·해제 후 aria-live 통지·섹션 heading +
 * aria-labelledby. 빈 상태/카운트 명확.
 *
 * DS: 신규 클래스 0. 기존 qf-btn(--ghost)·qf-empty·qf-badge + 토큰만(raw hex/px 0).
 * 카드는 설정 페이지의 기존 카드 패턴(rounded-[var(--r-xl)] border bg-bg-surface)을
 * 그대로 재사용한다.
 */
export function MuteListSection(): JSX.Element {
  const { data: channelData } = useMutes();
  const { data: serverData } = useServerMutes();
  const removeChannelMute = useRemoveChannelMute();
  const unmuteServer = useUnmuteServerFromList();
  const notify = useNotifications((s) => s.push);

  const headingId = useId();
  const channelListLabelId = useId();
  const serverListLabelId = useId();
  // 해제 결과를 SR 에 알리는 라이브 리전(시각적 비노출).
  const liveId = useId();

  const channels = channelData?.items ?? [];
  const servers = serverData?.items ?? [];
  const now = Date.now();
  const total = channels.length + servers.length;

  const announce = (msg: string): void => {
    const el = document.getElementById(liveId);
    if (el) el.textContent = msg;
  };

  const onUnmuteChannel = (channelId: string, name: string): void => {
    removeChannelMute.mutate(channelId, {
      onSuccess: () => announce(`${name} 채널 뮤트를 해제했습니다.`),
      onError: (err: unknown) =>
        notify({ variant: 'danger', title: '뮤트 해제 실패', body: (err as Error).message }),
    });
  };

  const onUnmuteServer = (workspaceId: string, name: string): void => {
    unmuteServer.mutate(workspaceId, {
      onSuccess: () => announce(`${name} 서버 뮤트를 해제했습니다.`),
      onError: (err: unknown) =>
        notify({ variant: 'danger', title: '뮤트 해제 실패', body: (err as Error).message }),
    });
  };

  return (
    <section
      className="mb-[var(--s-6)] rounded-[var(--r-xl)] border border-border bg-bg-surface p-[var(--s-5)]"
      data-testid="mute-list-section"
      aria-labelledby={headingId}
    >
      <h2
        id={headingId}
        className="mb-[var(--s-1)] text-[length:var(--fs-16)] font-semibold text-text-strong"
      >
        현재 뮤트 중{' '}
        <span className="qf-badge qf-badge--count" data-testid="mute-list-count">
          {total}
        </span>
      </h2>
      <p className="mb-[var(--s-4)] text-[length:var(--fs-12)] text-text-muted">
        뮤트한 채널과 서버 목록입니다. 남은 시간이 지나면 자동으로 해제됩니다.
      </p>

      {/* SR 전용 라이브 리전 — 해제 결과를 polite 로 알림. */}
      <div
        id={liveId}
        role="status"
        aria-live="polite"
        className="sr-only"
        data-testid="mute-list-live"
      />

      {total === 0 ? (
        <div className="qf-empty" data-testid="mute-list-empty">
          <p className="qf-empty__body">뮤트 중인 채널/서버가 없습니다.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-[var(--s-5)]">
          {/* ── 채널 뮤트 ── */}
          {channels.length > 0 && (
            <div>
              <h3
                id={channelListLabelId}
                className="mb-[var(--s-2)] text-[length:var(--fs-13)] font-semibold text-text-strong"
              >
                채널
              </h3>
              <ul
                aria-labelledby={channelListLabelId}
                className="flex flex-col gap-[var(--s-2)]"
                data-testid="mute-list-channels"
              >
                {channels.map((m) => (
                  <li
                    key={m.channelId}
                    data-testid={`mute-channel-${m.channelId}`}
                    className="flex items-center justify-between gap-[var(--s-3)] rounded-[var(--r-md)] border border-border-subtle bg-bg-subtle p-[var(--s-3)]"
                  >
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-[length:var(--fs-14)] text-foreground">
                        <span className="text-text-muted">#</span>
                        {m.channelName}
                      </span>
                      <span className="text-[length:var(--fs-12)] text-text-muted">
                        {m.workspaceName ? `${m.workspaceName} · ` : 'DM · '}
                        <time
                          dateTime={m.mutedUntil ?? undefined}
                          title={m.mutedUntil ? new Date(m.mutedUntil).toLocaleString() : '무기한'}
                        >
                          {formatMuteRemaining(m.mutedUntil, now)}
                        </time>
                      </span>
                    </div>
                    <button
                      type="button"
                      className="qf-btn qf-btn--ghost qf-btn--sm shrink-0"
                      data-testid={`unmute-channel-${m.channelId}`}
                      aria-label={`${m.channelName} 뮤트 해제`}
                      disabled={removeChannelMute.isPending}
                      onClick={() => onUnmuteChannel(m.channelId, m.channelName)}
                    >
                      해제
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* ── 서버 뮤트 ── */}
          {servers.length > 0 && (
            <div>
              <h3
                id={serverListLabelId}
                className="mb-[var(--s-2)] text-[length:var(--fs-13)] font-semibold text-text-strong"
              >
                서버
              </h3>
              <ul
                aria-labelledby={serverListLabelId}
                className="flex flex-col gap-[var(--s-2)]"
                data-testid="mute-list-servers"
              >
                {servers.map((m) => (
                  <li
                    key={m.workspaceId}
                    data-testid={`mute-server-${m.workspaceId}`}
                    className="flex items-center justify-between gap-[var(--s-3)] rounded-[var(--r-md)] border border-border-subtle bg-bg-subtle p-[var(--s-3)]"
                  >
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-[length:var(--fs-14)] text-foreground">
                        {m.workspaceName}
                      </span>
                      <span className="text-[length:var(--fs-12)] text-text-muted">
                        <time
                          dateTime={m.muteUntil ?? undefined}
                          title={m.muteUntil ? new Date(m.muteUntil).toLocaleString() : '무기한'}
                        >
                          {formatMuteRemaining(m.muteUntil, now)}
                        </time>
                      </span>
                    </div>
                    <button
                      type="button"
                      className="qf-btn qf-btn--ghost qf-btn--sm shrink-0"
                      data-testid={`unmute-server-${m.workspaceId}`}
                      aria-label={`${m.workspaceName} 뮤트 해제`}
                      disabled={unmuteServer.isPending}
                      onClick={() => onUnmuteServer(m.workspaceId, m.workspaceName)}
                    >
                      해제
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
