import { useMemo, useRef, useState } from 'react';
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
import { DndSnoozeControl } from '../notifications/DndSnoozeControl';
import { KeywordsInput } from '../notifications/KeywordsInput';
import { ServerNotifSettings } from '../notifications/ServerNotifSettings';
import { MuteListSection } from '../notifications/MuteListSection';

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

  // S48 (FR-MN-11): DND Snooze — dndUntil 저장/해제.
  const setSnooze = async (iso: string | null) => {
    try {
      await updateGlobal.mutateAsync({ dndUntil: iso });
    } catch (err) {
      notify({ variant: 'danger', title: '방해 금지 저장 실패', body: (err as Error).message });
    }
  };

  // S48 (FR-MN-10): 키워드 — 서버가 KEYWORD_LIMIT_EXCEEDED(400)로 권위 차단, 클라는
  // 25개 초과 시 선제 토스트(서버 왕복 없이).
  const keywords = globalSettings?.keywords ?? [];
  const setKeywords = async (next: string[]) => {
    try {
      await updateGlobal.mutateAsync({ keywords: next });
    } catch (err) {
      notify({ variant: 'danger', title: '키워드 저장 실패', body: (err as Error).message });
    }
  };
  const onKeywordLimit = () =>
    notify({
      variant: 'danger',
      title: '키워드 한도 초과',
      body: '키워드는 최대 25개까지 등록할 수 있습니다.',
    });

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
  // E-01: 탭 전환 시 tabpanel 로 포커스를 옮겨 SR/키보드 사용자가 새 패널 컨텍스트로 진입.
  const panelRef = useRef<HTMLDivElement>(null);
  const selectTab = (id: string): void => {
    setActiveTab(id);
    // 패널 콘텐츠가 리렌더된 다음 프레임에 포커스를 이동.
    requestAnimationFrame(() => panelRef.current?.focus());
  };

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

        {/* S48 (FR-MN-11): 임시 방해 금지(DND Snooze). */}
        <section
          className="mb-[var(--s-6)] rounded-[var(--r-xl)] border border-border bg-bg-surface p-[var(--s-5)]"
          data-testid="dnd-snooze-section"
          aria-labelledby="dnd-snooze-heading"
        >
          <h2
            id="dnd-snooze-heading"
            className="mb-[var(--s-1)] text-[length:var(--fs-16)] font-semibold text-text-strong"
          >
            임시 방해 금지
          </h2>
          <p className="mb-[var(--s-4)] text-[length:var(--fs-12)] text-text-muted">
            지정한 시각까지 멘션 알림을 잠시 끕니다. 만료되면 자동으로 해제됩니다.
          </p>
          <DndSnoozeControl
            dndUntil={globalSettings?.dndUntil ?? null}
            disabled={updateGlobal.isPending || !globalSettings}
            onSnooze={(iso) => void setSnooze(iso)}
            onClear={() => void setSnooze(null)}
          />
        </section>

        {/* S48 (FR-MN-10): 키워드 알림(스캔은 carryover). */}
        <section
          className="mb-[var(--s-6)] rounded-[var(--r-xl)] border border-border bg-bg-surface p-[var(--s-5)]"
          data-testid="keywords-section"
          aria-labelledby="keywords-heading"
        >
          <h2
            id="keywords-heading"
            className="mb-[var(--s-1)] text-[length:var(--fs-16)] font-semibold text-text-strong"
          >
            키워드 알림
          </h2>
          <p className="mb-[var(--s-4)] text-[length:var(--fs-12)] text-text-muted">
            등록한 키워드(최대 25개)가 메시지에 등장하면 알림을 받습니다.
          </p>
          <KeywordsInput
            keywords={keywords}
            disabled={updateGlobal.isPending || !globalSettings}
            onChange={(next) => void setKeywords(next)}
            onLimitExceeded={onKeywordLimit}
          />
        </section>

        {/* S49 (FR-MN-17): "현재 뮤트 중" 채널/서버 목록 + 남은 시간 + 개별 해제. */}
        <MuteListSection />

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
              onClick={() => selectTab(t.id)}
              className="qf-tabs__item"
            >
              {t.label}
            </button>
          ))}
        </div>

        <div
          ref={panelRef}
          role="tabpanel"
          id={`panel-${active.id}`}
          aria-labelledby={`tab-${active.id}`}
          tabIndex={0}
          className="overflow-hidden rounded-[var(--r-xl)] border border-border bg-bg-surface"
        >
          {/* S48 (FR-MN-09): 워크스페이스 탭에서 서버 알림 수준·뮤트·suppress 토글. */}
          {active.workspaceId !== null && (
            <div className="border-b border-border-subtle">
              <ServerNotifSettings key={active.workspaceId} workspaceId={active.workspaceId} />
            </div>
          )}
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="bg-bg-subtle text-[length:var(--fs-11)] uppercase tracking-[var(--tracking-caps)] text-text-muted">
                <th scope="col" className="px-[var(--s-5)] py-[var(--s-3)]">
                  이벤트
                </th>
                {CHANNELS.map((c) => (
                  <th key={c} scope="col" className="px-[var(--s-4)] py-[var(--s-3)] text-center">
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
                    <th
                      scope="row"
                      className="px-[var(--s-5)] py-[var(--s-4)] text-left font-medium"
                    >
                      {EVENT_LABEL[ev]}
                    </th>
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
