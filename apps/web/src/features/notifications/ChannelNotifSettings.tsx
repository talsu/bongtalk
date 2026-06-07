import type { ChannelNotificationPreference } from '@qufox/shared-types';
import { useChannelNotificationPref, usePutChannelNotificationPref } from './useNotifLevels';
import { useNotifications } from '../../stores/notification-store';

/**
 * S87 (D16 / FR-MN-18): 채널별 데스크톱/모바일 독립 push 알림 설정.
 *
 * 채널 오버라이드(UserChannelMute.pushDesktop/pushMobile)를 토글한다. null = 글로벌
 * (UserSettings.notifDesktop/notifMobile) 상속이며, 토글은 명시 true/false 로 오버라이드
 * 하고 "상속으로 재설정" 으로 다시 null 로 되돌린다. effective(전송 여부)는 서버 push.
 * processor 가 push ?? global ?? true 로 산정한다 — 여기서는 채널 오버라이드 값만 다룬다.
 *
 * globalDesktop/globalMobile 을 받아 상속 시 effective 값을 스위치에 반영한다(죽은 컨트롤
 * 방지 — 상속 상태에서도 현재 적용값이 보이게). 두 토글은 NotificationSettingsPage 의
 * 글로벌 device 토글(qf-switch · clock24h 토글 선례)과 동일 DS 패턴을 쓴다(신규 DS 클래스 0).
 *
 * 모든 변경은 PUT /workspaces/:wsId/channels/:chId/notification-preferences 로 저장한다.
 */
export interface ChannelNotifSettingsProps {
  workspaceId: string;
  channelId: string;
  /** 글로벌 notifDesktop(상속 시 effective 표시용). 미상이면 true 로 본다. */
  globalDesktop?: boolean;
  /** 글로벌 notifMobile(상속 시 effective 표시용). 미상이면 true 로 본다. */
  globalMobile?: boolean;
}

type DeviceKey = 'pushDesktop' | 'pushMobile';

export function ChannelNotifSettings({
  workspaceId,
  channelId,
  globalDesktop = true,
  globalMobile = true,
}: ChannelNotifSettingsProps): JSX.Element {
  const { data: pref } = useChannelNotificationPref(workspaceId, channelId);
  const putMut = usePutChannelNotificationPref(workspaceId, channelId);
  const notify = useNotifications((s) => s.push);

  const pushDesktop = pref?.pushDesktop ?? null;
  const pushMobile = pref?.pushMobile ?? null;
  const pending = putMut.isPending || !pref;

  const save = (patch: Partial<Pick<ChannelNotificationPreference, DeviceKey>>): void => {
    putMut.mutate(patch, {
      onError: (err: unknown) =>
        notify({ variant: 'danger', title: '알림 설정 저장 실패', body: (err as Error).message }),
    });
  };

  const rows: ReadonlyArray<{
    key: DeviceKey;
    title: string;
    desc: string;
    override: boolean | null;
    globalValue: boolean;
  }> = [
    {
      key: 'pushDesktop',
      title: '데스크톱 알림',
      desc: '이 채널의 멘션을 데스크톱으로 푸시할지 선택합니다.',
      override: pushDesktop,
      globalValue: globalDesktop,
    },
    {
      key: 'pushMobile',
      title: '모바일 알림',
      desc: '이 채널의 멘션을 모바일로 푸시할지 선택합니다.',
      override: pushMobile,
      globalValue: globalMobile,
    },
  ];

  return (
    <section
      aria-labelledby="channel-notif-device-heading"
      className="flex flex-col gap-[var(--s-3)]"
      data-testid="channel-notif-device-settings"
    >
      <div>
        <h3
          id="channel-notif-device-heading"
          className="mb-[var(--s-1)] text-[length:var(--fs-14)] font-semibold text-text-strong"
        >
          기기별 알림
        </h3>
        <p className="text-[length:var(--fs-12)] text-text-muted">
          이 채널만 데스크톱·모바일 알림을 따로 켜거나 끕니다. 설정하지 않으면 전체 알림 설정을
          따릅니다.
        </p>
      </div>

      {rows.map((row) => {
        // 상속(null)이면 글로벌 effective 값을 스위치에 표시한다.
        const inherited = row.override === null;
        const checked = inherited ? row.globalValue : (row.override as boolean);
        return (
          <div className="qf-toggle-row" key={row.key} data-testid={`channel-${row.key}-row`}>
            <div className="qf-toggle-row__text">
              <div className="qf-toggle-row__title">
                {row.title}
                {inherited && (
                  <span className="text-text-muted" data-testid={`channel-${row.key}-inherited`}>
                    {' · 전체 설정 따름'}
                  </span>
                )}
              </div>
              <div className="qf-toggle-row__desc">{row.desc}</div>
            </div>
            <div className="flex items-center gap-[var(--s-2)]">
              {!inherited && (
                <button
                  type="button"
                  className="qf-btn qf-btn--ghost qf-btn--sm"
                  disabled={pending}
                  data-testid={`channel-${row.key}-reset`}
                  onClick={() =>
                    save({ [row.key]: null } as Partial<
                      Pick<ChannelNotificationPreference, DeviceKey>
                    >)
                  }
                >
                  전체 설정 따르기
                </button>
              )}
              <button
                type="button"
                role="switch"
                aria-checked={checked}
                aria-label={row.title}
                disabled={pending}
                data-testid={`channel-${row.key}-toggle`}
                className="qf-switch"
                onClick={() =>
                  save({ [row.key]: !checked } as Partial<
                    Pick<ChannelNotificationPreference, DeviceKey>
                  >)
                }
              />
            </div>
          </div>
        );
      })}
    </section>
  );
}
