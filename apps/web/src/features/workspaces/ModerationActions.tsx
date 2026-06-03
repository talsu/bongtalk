import { useState } from 'react';
import { TIMEOUT_DURATION_PRESETS } from '@qufox/shared-types';
import { Dialog, Button } from '../../design-system/primitives';
import { useNotifications } from '../../stores/notification-store';
import { useBanMember, useKickMember, useKickUndo, useTimeoutMember } from './useWorkspaces';

type Props = {
  workspaceId: string;
  targetUserId: string;
  targetUsername: string;
};

type DialogKind = 'kick' | 'ban' | 'timeout' | null;

/**
 * S63 (D12 / FR-RM05·06·07): 멤버 행의 모더레이션 액션(Kick / Ban / Timeout).
 *
 * - Kick: 확인 다이얼로그 → 강제 퇴장 후 5초 Undo 토스트(actor 만 받는 undoToken).
 * - Ban: 영구차단 경고 다이얼로그 → 차단. Undo 없음.
 * - Timeout: duration picker(60s/5m/10m/1h/1d/7d) → 음소거.
 *
 * 권한은 서버(권한 비트 게이트)가 최종 권위다 — 이 컴포넌트는 canManage 권한자에게만
 * 렌더되며, 거부(403/404)는 토스트로 노출한다.
 */
export function ModerationActions({
  workspaceId,
  targetUserId,
  targetUsername,
}: Props): JSX.Element {
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [reason, setReason] = useState('');
  const [durationSeconds, setDurationSeconds] = useState<number>(
    TIMEOUT_DURATION_PRESETS[3]?.seconds ?? 3600,
  );
  const notify = useNotifications((s) => s.push);

  const kickMut = useKickMember(workspaceId);
  const undoMut = useKickUndo(workspaceId);
  const banMut = useBanMember(workspaceId);
  const timeoutMut = useTimeoutMember(workspaceId);

  const close = (): void => {
    setDialog(null);
    setReason('');
  };

  const trimmedReason = (): string | undefined => {
    const r = reason.trim();
    return r.length > 0 ? r : undefined;
  };

  const onKick = async (): Promise<void> => {
    try {
      const res = await kickMut.mutateAsync({ userId: targetUserId, reason: trimmedReason() });
      close();
      // FR-RM05: 5초 Undo 토스트. 토스트 액션이 kickUndo 를 호출해 재가입시킨다.
      notify({
        variant: 'warning',
        title: `${targetUsername} 님을 퇴장시켰습니다`,
        body: '5초 안에 되돌릴 수 있습니다.',
        action: {
          label: '되돌리기',
          onClick: () => {
            void undoMut
              .mutateAsync({ userId: targetUserId, undoToken: res.undoToken })
              .then(() =>
                notify({ variant: 'success', title: `${targetUsername} 님을 다시 초대했습니다` }),
              )
              .catch((err: Error) =>
                notify({ variant: 'danger', title: '되돌리기 실패', body: err.message }),
              );
          },
        },
        // S63 fix-forward (a11y BLOCKER-1 부분): Undo 토스트 TTL 을 5초→9초로 늘려
        // WCAG 2.2.1(Timing Adjustable)에 더 부합하게 한다. 서버 Undo 윈도는 여전히
        // 5초(KICK_UNDO_TTL_SECONDS)지만, 토스트가 더 오래 떠 있어야 사용자가 인지·
        // 조작할 시간이 확보된다(만료 후 클릭은 서버가 409 로 안내). plain-action 토스트의
        // live region 부재는 DS Toast primitive 설계라 carryover.
        ttlMs: 9000,
      });
    } catch (err) {
      notify({ variant: 'danger', title: '강제 퇴장 실패', body: (err as Error).message });
    }
  };

  const onBan = async (): Promise<void> => {
    try {
      await banMut.mutateAsync({ userId: targetUserId, reason: trimmedReason() });
      close();
      notify({ variant: 'success', title: `${targetUsername} 님을 영구 차단했습니다` });
    } catch (err) {
      notify({ variant: 'danger', title: '차단 실패', body: (err as Error).message });
    }
  };

  const onTimeout = async (): Promise<void> => {
    try {
      await timeoutMut.mutateAsync({
        userId: targetUserId,
        durationSeconds,
        reason: trimmedReason(),
      });
      close();
      notify({ variant: 'success', title: `${targetUsername} 님을 음소거했습니다` });
    } catch (err) {
      notify({ variant: 'danger', title: '음소거 실패', body: (err as Error).message });
    }
  };

  return (
    <span className="flex items-center gap-[var(--s-1)]">
      {/* S63 fix-forward (a11y MAJOR-2): 아이콘/짧은 라벨 버튼에 대상 username 을 포함한
          aria-label 을 달아 스크린리더가 누구를 대상으로 하는 액션인지 구분하게 한다. */}
      <Button
        variant="ghost"
        size="sm"
        data-testid={`mod-timeout-${targetUsername}`}
        aria-label={`${targetUsername} 님 음소거`}
        onClick={() => setDialog('timeout')}
      >
        음소거
      </Button>
      <Button
        variant="ghost"
        size="sm"
        data-testid={`mod-kick-${targetUsername}`}
        aria-label={`${targetUsername} 님 퇴장`}
        onClick={() => setDialog('kick')}
      >
        퇴장
      </Button>
      <Button
        variant="danger"
        size="sm"
        data-testid={`mod-ban-${targetUsername}`}
        aria-label={`${targetUsername} 님 차단`}
        onClick={() => setDialog('ban')}
      >
        차단
      </Button>

      {/* Kick 확인 */}
      <Dialog
        open={dialog === 'kick'}
        onOpenChange={(v) => {
          if (!v) close();
        }}
        title={`${targetUsername} 님 강제 퇴장`}
        description="강제 퇴장된 멤버는 다시 초대받으면 재가입할 수 있습니다. 5초 안에 되돌릴 수 있습니다."
      >
        <ReasonField value={reason} onChange={setReason} testid="mod-kick-reason" />
        <DialogFooter
          confirmLabel="퇴장"
          confirmVariant="primary"
          confirmTestid="mod-kick-confirm"
          pending={kickMut.isPending}
          onCancel={close}
          onConfirm={onKick}
        />
      </Dialog>

      {/* Ban 영구차단 경고 — S63 fix-forward (a11y HIGH-1): 되돌릴 수 없는 파괴적
          확인이므로 role="alertdialog" 로 노출한다(alertDialog prop). */}
      <Dialog
        open={dialog === 'ban'}
        onOpenChange={(v) => {
          if (!v) close();
        }}
        alertDialog
        title={`${targetUsername} 님 영구 차단`}
        description="차단된 멤버는 초대를 받아도 다시 가입할 수 없습니다. 이 작업은 되돌릴 수 없으며, 해제는 차단 목록에서만 가능합니다."
      >
        <ReasonField value={reason} onChange={setReason} testid="mod-ban-reason" />
        <DialogFooter
          confirmLabel="영구 차단"
          confirmVariant="danger"
          confirmTestid="mod-ban-confirm"
          pending={banMut.isPending}
          onCancel={close}
          onConfirm={onBan}
        />
      </Dialog>

      {/* Timeout duration picker */}
      <Dialog
        open={dialog === 'timeout'}
        onOpenChange={(v) => {
          if (!v) close();
        }}
        title={`${targetUsername} 님 음소거`}
        description="음소거 기간 동안 메시지 전송과 반응 추가가 차단됩니다. 채널 보기와 이전 메시지 열람은 유지됩니다."
      >
        <label
          htmlFor="mod-timeout-duration"
          className="mb-[var(--s-1)] block text-[length:var(--fs-11)] text-text-muted"
        >
          기간
        </label>
        <select
          id="mod-timeout-duration"
          data-testid="mod-timeout-duration"
          aria-label="음소거 기간"
          value={durationSeconds}
          onChange={(e) => setDurationSeconds(Number(e.target.value))}
          className="qf-input mb-[var(--s-3)] w-full text-[length:var(--fs-13)]"
        >
          {TIMEOUT_DURATION_PRESETS.map((p) => (
            <option key={p.seconds} value={p.seconds}>
              {p.label}
            </option>
          ))}
        </select>
        <ReasonField value={reason} onChange={setReason} testid="mod-timeout-reason" />
        <DialogFooter
          confirmLabel="음소거"
          confirmVariant="primary"
          confirmTestid="mod-timeout-confirm"
          pending={timeoutMut.isPending}
          onCancel={close}
          onConfirm={onTimeout}
        />
      </Dialog>
    </span>
  );
}

function ReasonField({
  value,
  onChange,
  testid,
}: {
  value: string;
  onChange: (v: string) => void;
  testid: string;
}): JSX.Element {
  return (
    <div className="mb-[var(--s-3)]">
      <label
        htmlFor={testid}
        className="mb-[var(--s-1)] block text-[length:var(--fs-11)] text-text-muted"
      >
        사유 (선택)
      </label>
      <input
        id={testid}
        data-testid={testid}
        aria-label="사유 (선택)"
        value={value}
        maxLength={512}
        onChange={(e) => onChange(e.target.value)}
        placeholder="사유를 입력하세요"
        className="qf-input w-full text-[length:var(--fs-13)]"
      />
    </div>
  );
}

function DialogFooter({
  confirmLabel,
  confirmVariant,
  confirmTestid,
  pending,
  onCancel,
  onConfirm,
}: {
  confirmLabel: string;
  confirmVariant: 'primary' | 'danger';
  confirmTestid: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}): JSX.Element {
  return (
    <div className="flex justify-end gap-[var(--s-2)]">
      <Button variant="secondary" size="sm" onClick={onCancel}>
        취소
      </Button>
      {/* S63 fix-forward (a11y MAJOR-1): 처리 중에는 aria-busy + 레이블을 "처리 중…" 으로
          바꿔 스크린리더에 진행 상태를 알린다(disabled 만으로는 상태 변화가 안 읽힌다). */}
      <Button
        variant={confirmVariant}
        size="sm"
        data-testid={confirmTestid}
        disabled={pending}
        aria-busy={pending}
        onClick={onConfirm}
      >
        {pending ? '처리 중…' : confirmLabel}
      </Button>
    </div>
  );
}
