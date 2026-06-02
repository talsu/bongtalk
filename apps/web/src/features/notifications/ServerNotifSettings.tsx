import { useState } from 'react';
import type { MuteDurationKey, NotifLevel } from '@qufox/shared-types';
import { NotifLevelRadio } from './NotifLevelRadio';
import { MuteToggle } from './MuteToggle';
import {
  useServerNotificationPref,
  usePutServerNotificationPref,
  useUnmuteServer,
} from './useNotifLevels';
import { useNotifications } from '../../stores/notification-store';

/**
 * S48 (D06 / FR-MN-09): 서버 단위 알림 설정 — 레벨 + 뮤트 + suppress 토글.
 *
 *   - NotifLevel(ALL/MENTIONS/NOTHING) 라디오(S46 게이트).
 *   - 서버 뮤트(S46).
 *   - suppress_everyone / suppress_role_mentions 토글(FR-MN-09). 게이트
 *     (shouldNotifyMention)는 S46 완료 — 본 슬라이스는 UI 노출이다.
 *
 * "Inbox 기록 유지"는 MentionRecord(S45) 의존이라 carryover(아직 미구현).
 * suppress_role_mentions 는 @role 멘션 자체가 미구현이라 현재 dormant(저장만 동작).
 * 모두 기존 PUT /workspaces/:wsId/notification-preferences 로 저장한다.
 *
 * DS 토큰 + 기존 qf-* 만(raw hex/px 0, 신규 DS 클래스 0).
 */
export interface ServerNotifSettingsProps {
  workspaceId: string;
}

export function ServerNotifSettings({ workspaceId }: ServerNotifSettingsProps): JSX.Element {
  const { data: pref } = useServerNotificationPref(workspaceId);
  const putMut = usePutServerNotificationPref(workspaceId);
  const unmuteMut = useUnmuteServer(workspaceId);
  const notify = useNotifications((s) => s.push);
  const [duration, setDuration] = useState<MuteDurationKey>('forever');

  const level: NotifLevel = pref?.level ?? 'MENTIONS';
  const isMuted = pref?.isMuted ?? false;
  const muteUntil = pref?.muteUntil ?? null;
  const suppressEveryone = pref?.suppressEveryone ?? false;
  const suppressRoleMentions = pref?.suppressRoleMentions ?? false;
  const pending = putMut.isPending || unmuteMut.isPending || !pref;

  const put = async (
    patch: Parameters<typeof putMut.mutateAsync>[0],
    failTitle: string,
  ): Promise<void> => {
    try {
      await putMut.mutateAsync(patch);
    } catch (err) {
      notify({ variant: 'danger', title: failTitle, body: (err as Error).message });
    }
  };

  return (
    <div
      className="flex flex-col gap-[var(--s-5)] p-[var(--s-5)]"
      data-testid="server-notif-settings"
    >
      <section aria-labelledby="server-notif-level-heading">
        <h3
          id="server-notif-level-heading"
          className="mb-[var(--s-3)] text-[length:var(--fs-14)] font-semibold text-text-strong"
        >
          이 서버의 알림 수준
        </h3>
        <NotifLevelRadio
          name={`server-${workspaceId}`}
          value={level}
          disabled={pending}
          onChange={(next) => void put({ level: next }, '알림 수준 저장 실패')}
        />
      </section>

      <section aria-labelledby="server-notif-mute-heading">
        <h3
          id="server-notif-mute-heading"
          className="mb-[var(--s-3)] text-[length:var(--fs-14)] font-semibold text-text-strong"
        >
          서버 뮤트
        </h3>
        <MuteToggle
          scope="server"
          isMuted={isMuted}
          muteUntil={muteUntil}
          duration={duration}
          disabled={pending}
          onToggle={(next) => {
            if (next) {
              void put({ isMuted: true, muteDuration: duration }, '서버 뮤트 저장 실패');
            } else {
              void unmuteMut.mutateAsync().catch((err: unknown) =>
                notify({
                  variant: 'danger',
                  title: '서버 뮤트 해제 실패',
                  body: (err as Error).message,
                }),
              );
            }
          }}
          onDurationChange={(next) => {
            setDuration(next);
            if (isMuted) void put({ isMuted: true, muteDuration: next }, '뮤트 기간 저장 실패');
          }}
        />
      </section>

      {/* FR-MN-09: suppress 토글. */}
      <section aria-labelledby="server-notif-suppress-heading">
        <h3
          id="server-notif-suppress-heading"
          className="mb-[var(--s-1)] text-[length:var(--fs-14)] font-semibold text-text-strong"
        >
          대량 멘션 알림 억제
        </h3>
        <p className="mb-[var(--s-3)] text-[length:var(--fs-12)] text-text-muted">
          이 서버에서 @everyone·@here 또는 역할 멘션의 알림과 배지를 끕니다. 직접 @멘션은 그대로
          알림을 받습니다.
        </p>
        <div className="flex flex-col gap-[var(--s-3)]">
          <label className="flex items-start gap-[var(--s-3)]">
            <input
              type="checkbox"
              checked={suppressEveryone}
              disabled={pending}
              data-testid="suppress-everyone-checkbox"
              aria-label="@everyone·@here 알림 억제"
              onChange={(e) =>
                void put({ suppressEveryone: e.target.checked }, '@everyone 억제 저장 실패')
              }
              className="mt-[var(--s-1)]"
            />
            <span className="flex flex-col">
              <span className="text-[length:var(--fs-14)] text-foreground">
                @everyone · @here 억제
              </span>
              <span className="text-[length:var(--fs-12)] text-text-muted">
                전체·접속자 멘션의 알림과 배지를 끕니다.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-[var(--s-3)]">
            <input
              type="checkbox"
              checked={suppressRoleMentions}
              disabled={pending}
              data-testid="suppress-role-checkbox"
              aria-label="역할 멘션 알림 억제"
              onChange={(e) =>
                void put({ suppressRoleMentions: e.target.checked }, '역할 멘션 억제 저장 실패')
              }
              className="mt-[var(--s-1)]"
            />
            <span className="flex flex-col">
              <span className="text-[length:var(--fs-14)] text-foreground">역할 멘션 억제</span>
              <span className="text-[length:var(--fs-12)] text-text-muted">
                @역할 멘션의 알림과 배지를 끕니다.
              </span>
            </span>
          </label>
        </div>
      </section>
    </div>
  );
}
