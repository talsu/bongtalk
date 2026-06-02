import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  NotificationChannel,
  NotificationEventType,
  NotificationPreference,
} from '@qufox/shared-types';
import { useMyWorkspaces } from '../workspaces/useWorkspaces';
import { useNotifications } from '../../stores/notification-store';
import {
  HARDCODED_DEFAULTS,
  resolveChannel,
  useNotificationPreferences,
  useUpsertNotificationPreference,
} from '../notifications/useNotificationPreferences';
import type { NotifLevel } from '@qufox/shared-types';
import {
  useGlobalNotificationSettings,
  useUpdateGlobalNotificationSettings,
} from '../notifications/useNotifLevels';
import { NotifLevelRadio } from '../notifications/NotifLevelRadio';

const EVENT_TYPES: readonly NotificationEventType[] = [
  'MENTION',
  'REPLY',
  'REACTION',
  'DIRECT',
  'FRIEND_REQUEST',
];
const CHANNELS: readonly NotificationChannel[] = ['TOAST', 'BROWSER', 'BOTH', 'OFF'];

const EVENT_LABEL: Record<NotificationEventType, string> = {
  MENTION: '@멘션',
  REPLY: '스레드 답글',
  REACTION: '리액션',
  DIRECT: 'DM',
  FRIEND_REQUEST: '친구 요청',
};

const CHANNEL_LABEL: Record<NotificationChannel, string> = {
  TOAST: '토스트만',
  BROWSER: '브라우저 알림만',
  BOTH: '토스트 + 브라우저',
  OFF: '끔',
};

export function NotificationSettingsPage(): JSX.Element {
  const { data: mine } = useMyWorkspaces();
  const { data: prefs } = useNotificationPreferences();
  const upsertMut = useUpsertNotificationPreference();
  const notify = useNotifications((s) => s.push);

  // S46 (FR-MN-05): 글로벌 알림 수준(NotifLevel — ALL/MENTIONS/NOTHING).
  const { data: globalSettings } = useGlobalNotificationSettings();
  const updateGlobal = useUpdateGlobalNotificationSettings();
  const setGlobalLevel = async (next: NotifLevel) => {
    try {
      await updateGlobal.mutateAsync({ notifTrigger: next });
    } catch (err) {
      notify({ variant: 'danger', title: '알림 수준 저장 실패', body: (err as Error).message });
    }
  };

  const workspaces = useMemo(() => mine?.workspaces ?? [], [mine]);
  // Tabs: "Global" first, then one per workspace the user is in.
  type Tab = { id: string; label: string; workspaceId: string | null };
  const tabs = useMemo<Tab[]>(
    () => [
      { id: 'global', label: '전체 기본값', workspaceId: null },
      ...workspaces.map((w) => ({ id: w.id, label: w.name, workspaceId: w.id })),
    ],
    [workspaces],
  );
  const [activeTab, setActiveTab] = useState<string>('global');
  const active = tabs.find((t) => t.id === activeTab) ?? tabs[0];

  const currentChannel = (eventType: NotificationEventType): NotificationChannel =>
    resolveChannel(prefs as NotificationPreference[] | undefined, active.workspaceId, eventType);

  const flip = async (eventType: NotificationEventType, channel: NotificationChannel) => {
    try {
      await upsertMut.mutateAsync({
        workspaceId: active.workspaceId,
        eventType,
        channel,
      });
    } catch (err) {
      notify({
        variant: 'danger',
        title: '설정 저장 실패',
        body: (err as Error).message,
      });
    }
  };

  return (
    <main
      className="min-h-full bg-background p-[var(--s-7)]"
      data-testid="notification-settings-page"
    >
      <div className="mx-auto max-w-[var(--w-settings)]">
        <div className="mb-[var(--s-5)] flex items-center justify-between">
          <div>
            <div className="qf-eyebrow">settings</div>
            <h1 className="text-[length:var(--fs-24)] font-semibold tracking-[var(--tracking-tight)] text-text-strong">
              알림 설정
            </h1>
          </div>
          <Link to="/" className="qf-btn qf-btn--ghost">
            ← 홈으로
          </Link>
        </div>

        {/* S46 (FR-MN-05): 글로벌 알림 수준 (NotifLevel). M-03: section aria-labelledby. */}
        <section
          className="mb-[var(--s-6)] rounded-[var(--r-xl)] border border-border bg-bg-surface p-[var(--s-5)]"
          data-testid="global-notif-level"
          aria-labelledby="global-notif-level-heading"
        >
          <h2
            id="global-notif-level-heading"
            className="mb-[var(--s-1)] text-[length:var(--fs-16)] font-semibold text-text-strong"
          >
            알림 수준
          </h2>
          <p className="mb-[var(--s-4)] text-[length:var(--fs-12)] text-text-muted">
            모든 서버의 기본 알림 수준입니다. 서버·채널에서 개별 재정의할 수 있습니다.
          </p>
          <NotifLevelRadio
            name="global"
            value={globalSettings?.notifTrigger ?? 'MENTIONS'}
            disabled={updateGlobal.isPending || !globalSettings}
            onChange={(next) => void setGlobalLevel(next)}
          />
        </section>

        {/* B-01: tablist — 각 탭 id + aria-controls, 패널 role=tabpanel + aria-labelledby. */}
        <div className="qf-tabs mb-[var(--s-5)]" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`tab-${t.id}`}
              aria-controls={`panel-${t.id}`}
              aria-selected={t.id === activeTab}
              data-testid={`notif-tab-${t.id}`}
              onClick={() => setActiveTab(t.id)}
              className="qf-tabs__item"
            >
              {t.label}
            </button>
          ))}
        </div>

        <div
          role="tabpanel"
          id={`panel-${active.id}`}
          aria-labelledby={`tab-${active.id}`}
          tabIndex={0}
          className="overflow-hidden rounded-[var(--r-xl)] border border-border bg-bg-surface"
        >
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="bg-bg-subtle text-[length:var(--fs-11)] uppercase tracking-[var(--tracking-caps)] text-text-muted">
                <th className="px-[var(--s-5)] py-[var(--s-3)]">이벤트</th>
                {CHANNELS.map((c) => (
                  <th key={c} className="px-[var(--s-4)] py-[var(--s-3)] text-center">
                    {CHANNEL_LABEL[c]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {EVENT_TYPES.map((ev) => {
                const current = currentChannel(ev);
                return (
                  <tr
                    key={ev}
                    data-testid={`notif-row-${ev}`}
                    className="border-t border-border-subtle text-[length:var(--fs-14)] text-foreground"
                  >
                    <td className="px-[var(--s-5)] py-[var(--s-4)] font-medium">
                      {EVENT_LABEL[ev]}
                    </td>
                    {CHANNELS.map((c) => (
                      <td key={c} className="px-[var(--s-4)] py-[var(--s-4)] text-center">
                        <label className="inline-flex cursor-pointer items-center justify-center">
                          <input
                            type="radio"
                            name={`notif-${active.id}-${ev}`}
                            data-testid={`notif-radio-${active.id}-${ev}-${c}`}
                            checked={current === c}
                            onChange={() => void flip(ev, c)}
                            disabled={upsertMut.isPending}
                            aria-label={`${EVENT_LABEL[ev]} → ${CHANNEL_LABEL[c]}`}
                          />
                        </label>
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="mt-[var(--s-4)] text-[length:var(--fs-12)] text-text-muted">
          기본값:{' '}
          {EVENT_TYPES.map(
            (ev) => `${EVENT_LABEL[ev]}=${CHANNEL_LABEL[HARDCODED_DEFAULTS[ev]]}`,
          ).join(' · ')}
        </p>
        <p className="mt-[var(--s-2)] text-[length:var(--fs-12)] text-text-muted">
          변경 사항은 최대 5분 이내에 모든 탭에 반영됩니다.
        </p>
      </div>
    </main>
  );
}
